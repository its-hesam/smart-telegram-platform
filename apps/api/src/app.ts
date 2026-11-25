import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Body, Catch, Controller, Delete, Get, HttpCode, HttpException, Inject, Module, Param, Patch, Post, Query, Req, Res, StreamableFile, UseGuards, type ArgumentsHost, type CanActivate, type ExceptionFilter, type ExecutionContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import type { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import pino from 'pino';
import { z } from 'zod';
import { checkDependencies } from '../../../packages/shared/src/health.js';
import { accountInputSchema } from '../../../packages/validation/src/index.js';
import type { ApiConfig } from './config.js';
import { FieldCipher, csrfFor, equalSecret } from './crypto.js';
import { accountPatchSchema, accountQuerySchema, loginSchema, type Principal } from './contracts.js';
import { PlatformStore, problem } from './store.js';
import { AuthService } from './auth.service.js';
import type { RateLimiter } from './rate-limit.js';
import { ContactsService, contactInputSchema, contactPatchSchema, consentInputSchema, contactQuerySchema, listSchema, importSchema } from './contacts.js';
import { CampaignsService, campaignInputSchema, pagingSchema } from './campaigns.js';
import { OperationsService, targetInputSchema, logsQuerySchema } from './operations.js';
import { metrics, requestCount, requestDuration, tracer } from './telemetry.js';
import { telegramLoginCommand } from '../../../packages/shared/src/telegram-login.js';
import { forwardTelegramLogin } from './telegram-login.js';
import { AccountSourcesService } from './account-sources.js';
import { sourceSelectionSchema, memberExportSchema } from '../../../packages/shared/src/account-sources.js';
import { contactExportFilterSchema, contactExportJobSchema } from '../../../packages/shared/src/contact-export.js';

interface ApiRequest extends Request { requestId: string; principal?: Principal; sessionToken?: string; }
interface Dependencies { config: ApiConfig; store: PlatformStore; auth: AuthService; limiter: RateLimiter; }
interface Dependencies { contacts?: ContactsService; }
interface Dependencies { campaigns?: CampaignsService; }
interface Dependencies { operations?: OperationsService; }
interface Dependencies { sources?: AccountSourcesService; }
const dependencies = Symbol('dependencies');
const cookieName = (config: ApiConfig) => config.NODE_ENV === 'production' ? '__Host-smart_session' : 'smart_session';
const unsafe = (method: string) => !['GET', 'HEAD', 'OPTIONS'].includes(method);
export function assertOrigin(origin: string | undefined, expected: string): void {
  if (origin !== expected) problem(403, 'ORIGIN_REJECTED', 'Request origin is not allowed');
}
export function assertCsrf(token: string | undefined, header: string | undefined): void {
  if (!token || !header || !equalSecret(csrfFor(token), header)) problem(403, 'CSRF_REJECTED', 'CSRF token is invalid');
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) problem(400, 'VALIDATION_FAILED', 'Request does not match the API contract');
  return result.data;
}
const idSchema = z.uuid();
function principal(req: ApiRequest): Principal { if (!req.principal) problem(401, 'AUTH_REQUIRED', 'Authentication required'); return req.principal; }
class SessionGuard implements CanActivate {
  constructor(@Inject(dependencies) private readonly deps: Dependencies) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<ApiRequest>();
    const cookies = req.cookies as Record<string, unknown> | undefined;
    const token = cookies?.[cookieName(this.deps.config)];
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) problem(401, 'AUTH_REQUIRED', 'Authentication required');
    const user = await this.deps.store.authenticate(token);
    if (!user) problem(401, 'AUTH_REQUIRED', 'Authentication required');
    if (unsafe(req.method)) assertCsrf(token, req.get('x-csrf-token'));
    req.principal = user; req.sessionToken = token;
    return true;
  }
}
class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    if (principal(context.switchToHttp().getRequest<ApiRequest>()).role !== 'ADMIN') problem(403, 'FORBIDDEN', 'Administrator role required');
    return true;
  }
}
class EditorGuard implements CanActivate {
  canActivate(context: ExecutionContext) { if (principal(context.switchToHttp().getRequest<ApiRequest>()).role === 'VIEWER') problem(403, 'FORBIDDEN', 'Editor role required'); return true; }
}
@Catch()
class ApiErrors implements ExceptionFilter {
  constructor(private readonly logger: pino.Logger) {}
  catch(error: unknown, host: ArgumentsHost) {
    const req = host.switchToHttp().getRequest<ApiRequest>();
    const res = host.switchToHttp().getResponse<Response>();
    let status = 500; let code = 'INTERNAL_ERROR'; let message = 'Request could not be completed';
    if (error instanceof HttpException) {
      status = error.getStatus(); const body = error.getResponse();
      if (typeof body === 'object' && body !== null && 'code' in body && 'message' in body) {
        code = String(body.code); message = String(body.message);
      } else { code = `HTTP_${status}`; message = status === 404 ? 'Route not found' : 'Request rejected'; }
    } else if (typeof error === 'object' && error !== null && 'status' in error && [400, 413].includes(Number(error.status))) {
      status = Number(error.status); code = status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_JSON'; message = 'Request body rejected';
    } else if (typeof error === 'object' && error !== null && 'code' in error) {
      if (['P2002', 'P2003', 'P2034'].includes(String(error.code))) { status = 409; code = 'RESOURCE_CONFLICT'; message = 'Resource already exists, is referenced or changed concurrently'; }
      if (['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'ECONNREFUSED', 'ETIMEDOUT'].includes(String(error.code))) { status = 503; code = 'DATABASE_UNAVAILABLE'; message = 'Database temporarily unavailable'; }
      if (String(error.code) === 'P2025') { status = 404; code = 'RESOURCE_NOT_FOUND'; message = 'Resource not found'; }
    }
    if (status === 500) this.logger.error({ requestId: req.requestId, code }, 'Request failed');
    res.status(status).json({ code, message, requestId: req.requestId });
  }
}
@Controller('auth')
class AuthController {
  constructor(@Inject(dependencies) private readonly deps: Dependencies) {}
  @Post('login') @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const input = parse(loginSchema, body);
    const cipher = new FieldCipher(this.deps.config.DATA_ENCRYPTION_KEY, this.deps.config.IDENTITY_HMAC_KEY);
    if (!await this.deps.limiter.consume(`login:${cipher.identity(input.email)}`, 5, 900)) problem(429, 'RATE_LIMITED', 'Too many login attempts');
    if (!await this.deps.limiter.consume(`login-ip:${cipher.identity(req.ip ?? 'unknown')}`, 20, 900)) problem(429, 'RATE_LIMITED', 'Too many login attempts');
    const result = await this.deps.auth.login(input.email, input.password);
    res.cookie(cookieName(this.deps.config), result.token, { httpOnly: true, secure: this.deps.config.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: this.deps.config.SESSION_TTL_SECONDS * 1000 });
    return { user: result.user, csrfToken: csrfFor(result.token), expiresAt: result.expiresAt };
  }
  @Get('me') @UseGuards(SessionGuard)
  me(@Req() req: ApiRequest) { return { user: principal(req), csrfToken: csrfFor(req.sessionToken!) }; }
  @Post('logout') @HttpCode(204) @UseGuards(SessionGuard)
  async logout(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    await this.deps.store.logout(principal(req), req.sessionToken!);
    res.clearCookie(cookieName(this.deps.config), { httpOnly: true, secure: this.deps.config.NODE_ENV === 'production', sameSite: 'strict', path: '/' });
  }
}
@Controller('accounts') @UseGuards(SessionGuard)
class AccountsController {
  constructor(@Inject(dependencies) private readonly deps: Dependencies) {}
  private sources() { if (!this.deps.sources) problem(503, 'MODULE_UNAVAILABLE', 'Account sources unavailable'); return this.deps.sources; }
  @Get(':id/sources') @UseGuards(AdminGuard)
  accountSources(@Param('id') id: string) { return this.sources().list(parse(idSchema, id)); }
  @Post(':id/sources/refresh') @HttpCode(202) @UseGuards(AdminGuard)
  refreshSources(@Req() req: ApiRequest, @Param('id') id: string) { return this.sources().refresh(principal(req), parse(idSchema, id)); }
  @Post(':id/sources/select') @UseGuards(AdminGuard)
  selectSources(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) { const input = parse(sourceSelectionSchema, body); return this.sources().select(principal(req), parse(idSchema, id), input.sourceIds); }
  @Get() list(@Req() req: ApiRequest, @Query() query: unknown) { return this.deps.store.listAccounts(principal(req), parse(accountQuerySchema, query)); }
  @Post() @UseGuards(AdminGuard)
  create(@Req() req: ApiRequest, @Body() body: unknown) { return this.deps.store.createAccount(principal(req), parse(accountInputSchema, body)); }
  @Get(':id') get(@Req() req: ApiRequest, @Param('id') id: string) { return this.deps.store.getAccount(principal(req), parse(idSchema, id)); }
  @Patch(':id') @UseGuards(AdminGuard)
  update(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) { return this.deps.store.updateAccount(principal(req), parse(idSchema, id), parse(accountPatchSchema, body)); }
  @Delete(':id') @HttpCode(204) @UseGuards(AdminGuard)
  async remove(@Req() req: ApiRequest, @Param('id') id: string) { await this.deps.store.deleteAccount(principal(req), parse(idSchema, id)); }
  @Get(':id/health') health(@Req() req: ApiRequest, @Param('id') id: string) { return this.deps.store.accountHealth(principal(req), parse(idSchema, id)); }
  @Post(':id/connect') @HttpCode(202) @UseGuards(AdminGuard)
  async connect(@Req() req: ApiRequest, @Param('id') id: string) { return this.deps.store.validateSessionJob(principal(req), parse(idSchema, id)); }
  @Post(':id/disconnect') @UseGuards(AdminGuard)
  async disconnect(@Req() req: ApiRequest, @Param('id') id: string) { await this.deps.store.getAccount(principal(req), parse(idSchema, id)); problem(501, 'OPERATION_UNSUPPORTED', 'Browser profile lifecycle is not implemented until phase 3'); }
  @Post(':id/login') @HttpCode(200) @UseGuards(AdminGuard)
  async telegramLogin(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    const accountId = parse(idSchema, id); const command = parse(telegramLoginCommand, body); const actor = principal(req);
    await this.deps.store.getAccount(actor, accountId);
    if (command.action === 'start' && !await this.deps.limiter.consume(`telegram-login-start:${actor.id}:${accountId}`, 3, 900)) problem(429, 'RATE_LIMITED', 'Too many login starts');
    if (command.action !== 'status' && !await this.deps.limiter.consume(`telegram-login:${actor.id}:${accountId}`, 15, 900)) problem(429, 'RATE_LIMITED', 'Too many login attempts');
    return forwardTelegramLogin(this.deps.config, accountId, actor.id, req.sessionToken!, command);
  }
}
@Controller('contacts') @UseGuards(SessionGuard, EditorGuard)
class ContactsController {
  constructor(@Inject(dependencies) private readonly deps: Dependencies) {}
  private service() { if (!this.deps.contacts) problem(503, 'MODULE_UNAVAILABLE', 'Contacts module unavailable'); return this.deps.contacts; }
  @Get() list(@Query() query: unknown) { return this.service().list(parse(contactQuerySchema, query)); }
  @Post() create(@Req() req: ApiRequest, @Body() body: unknown) { return this.service().create(principal(req), parse(contactInputSchema, body)); }
  @Post('import') @HttpCode(200) import(@Req() req: ApiRequest, @Body() body: unknown) { return this.service().import(principal(req), parse(importSchema, body)); }
  @Get('export') @UseGuards(AdminGuard)
  async export(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response, @Query() query: unknown) {
    const filter = parse(contactExportFilterSchema, query);
    const stream = await this.service().exportCsvStream(principal(req), filter);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', 'attachment; filename="contacts.csv"'); res.setHeader('Cache-Control', 'no-store');
    return new StreamableFile(stream);
  }
  @Post('export/jobs') @HttpCode(202) @UseGuards(AdminGuard)
  async createExport(@Req() req: ApiRequest, @Body() body: unknown) {
    const input = parse(contactExportJobSchema, body); const { format, ...filter } = input;
    return this.service().createExportJob(principal(req), format, filter);
  }
  @Get('export/jobs/:id') @UseGuards(AdminGuard)
  exportJob(@Req() req: ApiRequest, @Param('id') id: string) { return this.service().exportJob(principal(req), parse(idSchema, id)); }
  @Get('export/jobs/:id/file') @UseGuards(AdminGuard)
  async exportFile(@Req() req: ApiRequest, @Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const file = await this.service().exportFile(principal(req), parse(idSchema, id));
    res.setHeader('Content-Type', file.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`); res.setHeader('Cache-Control', 'no-store');
    return new StreamableFile(createReadStream(file.path));
  }
  @Post('export/jobs/:id/resume') @HttpCode(202) @UseGuards(AdminGuard)
  resumeExport(@Req() req: ApiRequest, @Param('id') id: string) { return this.service().resumeExportJob(principal(req), parse(idSchema, id)); }
  @Post(':id/suppress') @HttpCode(204)
  async suppress(@Req() req: ApiRequest, @Param('id') id: string) { await this.service().suppress(principal(req), parse(idSchema, id)); }
  @Patch(':id') update(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) { return this.service().update(principal(req), parse(idSchema, id), parse(contactPatchSchema, body)); }
  @Patch(':id/consent') @HttpCode(204)
  async consent(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) { await this.service().consent(principal(req), parse(idSchema, id), parse(consentInputSchema, body)); }
  @Delete(':id') @HttpCode(204) @UseGuards(AdminGuard)
  async erase(@Req() req: ApiRequest, @Param('id') id: string) { await this.service().erase(principal(req), parse(idSchema, id)); }
  @Delete(':id/record') @HttpCode(204) @UseGuards(AdminGuard)
  async removeContactRecord(@Req() req: ApiRequest, @Param('id') id: string) { await this.service().removeRecord(principal(req), parse(idSchema, id)); }
}
@Controller('contact-lists') @UseGuards(SessionGuard, EditorGuard)
class ListsController {
  constructor(@Inject(dependencies) private readonly deps: Dependencies) {}
  private service() { if (!this.deps.contacts) problem(503, 'MODULE_UNAVAILABLE', 'Contacts module unavailable'); return this.deps.contacts; }
  @Get() list() { return this.service().lists(); }
  @Post() create(@Req() req: ApiRequest, @Body() body: unknown) { return this.service().createList(principal(req), parse(listSchema, body)); }
  @Post(':id/members') @HttpCode(204)
  async members(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) { const input = parse(z.strictObject({ contactIds: z.array(z.uuid()).min(1).max(100) }), body); await this.service().listMembers(principal(req), parse(idSchema, id), input.contactIds); }
  @Patch(':id') @HttpCode(204) async rename(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) { const input = parse(z.strictObject({ name: z.string().trim().min(1).max(100) }), body); await this.service().renameList(principal(req), parse(idSchema, id), input.name); }
  @Delete(':id') @HttpCode(204) @UseGuards(AdminGuard) async remove(@Req() req: ApiRequest, @Param('id') id: string) { await this.service().deleteList(principal(req), parse(idSchema, id)); }
  @Post(':id/merge') @HttpCode(204) async merge(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) { const input = parse(z.strictObject({ sourceId: z.uuid() }), body); await this.service().mergeLists(principal(req), parse(idSchema, id), input.sourceId); }
}

@Controller('campaigns') @UseGuards(SessionGuard, EditorGuard)
class CampaignsController {
  constructor(@Inject(dependencies) private readonly deps: Dependencies) {}
  private service() { if (!this.deps.campaigns) problem(503, 'MODULE_UNAVAILABLE', 'Campaigns module unavailable'); return this.deps.campaigns; }
  @Get() list(@Query() query: unknown) { return this.service().list(parse(pagingSchema, query)); }
  @Get(':id') get(@Param('id') id: string) { return this.service().get(parse(idSchema, id)); }
  @Get(':id/templates') history(@Param('id') id: string) { return this.service().templateHistory(parse(idSchema, id)); }
  @Patch(':id/template') revise(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) { const input = parse(z.strictObject({ content: campaignInputSchema.shape.content }), body); return this.service().reviseTemplate(principal(req), parse(idSchema, id), input.content); }
  @Post() create(@Req() req: ApiRequest, @Body() body: unknown) { return this.service().create(principal(req), parse(campaignInputSchema, body)); }
  @Post(':id/validate') @HttpCode(200) validate(@Param('id') id: string) { return this.service().validate(parse(idSchema, id)); }
  @Post(':id/start') @HttpCode(202) start(@Req() req: ApiRequest, @Param('id') id: string) { return this.service().start(principal(req), parse(idSchema, id)); }
  @Post(':id/test-send') @HttpCode(202) test(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) { const input = parse(z.strictObject({ contactId: z.uuid(), creationKey: z.uuid() }), body); return this.service().testSend(principal(req), parse(idSchema, id), input.contactId, input.creationKey); }
  @Post(':id/pause') @HttpCode(204) async pause(@Req() req: ApiRequest, @Param('id') id: string) { await this.service().transition(principal(req), parse(idSchema, id), 'pause'); }
  @Post(':id/resume') @HttpCode(204) async resume(@Req() req: ApiRequest, @Param('id') id: string) { await this.service().transition(principal(req), parse(idSchema, id), 'resume'); }
  @Post(':id/cancel') @HttpCode(204) async cancel(@Req() req: ApiRequest, @Param('id') id: string) { await this.service().transition(principal(req), parse(idSchema, id), 'cancel'); }
}
@Controller('targets') @UseGuards(SessionGuard, AdminGuard)
class TargetsController {
  constructor(@Inject(dependencies) private readonly deps: Dependencies) {}
  @Post(':id/extract-members') @HttpCode(202)
  extractMembers(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) { if (!this.deps.sources) problem(503, 'MODULE_UNAVAILABLE', 'Account sources unavailable'); return this.deps.sources.extract(principal(req), parse(idSchema, id), parse(memberExportSchema, body).limit); }
  @Get('member-exports/recent')
  memberExports() { if (!this.deps.sources) problem(503, 'MODULE_UNAVAILABLE', 'Account sources unavailable'); return this.deps.sources.exports(); }
  @Get('member-exports/:id/csv')
  async memberCsv(@Req() req: ApiRequest, @Param('id') id: string, @Res({ passthrough: true }) res: Response) { if (!this.deps.sources) problem(503, 'MODULE_UNAVAILABLE', 'Account sources unavailable'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', 'attachment; filename="group-members.csv"'); return this.deps.sources.csv(principal(req), parse(idSchema, id)); }
  @Get('member-exports/:id/xlsx')
  async memberXlsx(@Req() req: ApiRequest, @Param('id') id: string, @Res() res: Response) { if (!this.deps.sources) problem(503, 'MODULE_UNAVAILABLE', 'Account sources unavailable'); const bytes = await this.deps.sources.xlsx(principal(req), parse(idSchema, id)); res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.setHeader('Content-Disposition', 'attachment; filename="telegram-members.xlsx"'); res.send(bytes); }
  @Post('member-exports/:id/import') @HttpCode(200)
  async importMemberContacts(@Req() req: ApiRequest, @Param('id') id: string) { if (!this.deps.sources) problem(503, 'MODULE_UNAVAILABLE', 'Account sources unavailable'); return this.deps.sources.importContacts(principal(req), parse(idSchema, id)); }
  private service() { if (!this.deps.operations) problem(503, 'MODULE_UNAVAILABLE', 'Operations unavailable'); return this.deps.operations; }
  @Get() list() { return this.service().targets(); }
  @Post() create(@Req() req: ApiRequest, @Body() body: unknown) { return this.service().createTarget(principal(req), parse(targetInputSchema, body)); }
  @Get(':id') get(@Param('id') id: string) { return this.service().target(parse(idSchema, id)); }
  @Post(':id/invite-link') unsupported(@Param('id') id: string) { parse(idSchema, id); problem(501, 'OPERATION_UNSUPPORTED', 'Verified UI management permissions and invitation selectors required'); }
  @Post(':id/join-requests') requests(@Param('id') id: string) { parse(idSchema, id); problem(501, 'OPERATION_UNSUPPORTED', 'Join-request moderation not verified in Telegram UI'); }
}
@Controller('invitations') @UseGuards(SessionGuard, AdminGuard)
class InvitationsController {
  constructor(@Inject(dependencies) private readonly deps: Dependencies) {}
  private service() { if (!this.deps.operations) problem(503, 'MODULE_UNAVAILABLE', 'Operations unavailable'); return this.deps.operations; }
  @Get() list() { return this.service().invitations(); }
  @Post() create(@Req() req: ApiRequest, @Body() body: unknown) { const input = parse(z.strictObject({ targetId: z.uuid(), link: z.string().regex(/^https:\/\/t\.me\/(?:\+|joinchat\/)[A-Za-z0-9_-]+$/), authorizationConfirmed: z.literal(true) }), body); return this.service().registerInvitation(principal(req), input); }
  @Get(':id/link') link(@Param('id') id: string) { return this.service().invitationLink(parse(idSchema, id)); }
}
@Controller('jobs') @UseGuards(SessionGuard)
class JobsController {
  constructor(@Inject(dependencies) private readonly deps: Dependencies) {}
  private service() { if (!this.deps.operations) problem(503, 'MODULE_UNAVAILABLE', 'Operations unavailable'); return this.deps.operations; }
  @Get() list(@Query() query: unknown) { const input = parse(pagingSchema, query); return this.service().jobs(input.page, input.pageSize); }
  @Get(':id') get(@Param('id') id: string) { return this.service().job(parse(idSchema, id)); }
  @Post(':id/cancel') @HttpCode(204) @UseGuards(EditorGuard) async cancel(@Req() req: ApiRequest, @Param('id') id: string) { await this.service().cancelJob(principal(req), parse(idSchema, id)); }
}
@Controller('analytics') @UseGuards(SessionGuard)
class AnalyticsController {
  constructor(@Inject(dependencies) private readonly deps: Dependencies) {}
  @Get('overview') overview() { if (!this.deps.operations) problem(503, 'MODULE_UNAVAILABLE', 'Analytics unavailable'); return this.deps.operations.overview(); }
  @Get('metrics') @UseGuards(AdminGuard) async metrics(@Res({ passthrough: true }) res: Response) { res.setHeader('Content-Type', metrics.contentType); return metrics.metrics(); }
}
@Controller('logs') @UseGuards(SessionGuard, AdminGuard)
class LogsController {
  constructor(@Inject(dependencies) private readonly deps: Dependencies) {}
  @Get() list(@Query() query: unknown) { if (!this.deps.operations) problem(503, 'MODULE_UNAVAILABLE', 'Logs unavailable'); return this.deps.operations.logs(parse(logsQuerySchema, query)); }
}
@Controller('settings') @UseGuards(SessionGuard, AdminGuard)
class SettingsController {
  constructor(@Inject(dependencies) private readonly deps: Dependencies) {}
  @Get() get() { if (!this.deps.operations) problem(503, 'MODULE_UNAVAILABLE', 'Settings unavailable'); return this.deps.operations.settings(); }
  @Get('outreach-authorization') authorization() { if (!this.deps.operations) problem(503, 'MODULE_UNAVAILABLE', 'Settings unavailable'); return this.deps.operations.outreachAuthorization(); }
  @Post('outreach-authorization') @HttpCode(201)
  async authorizeOutreach(@Req() req: ApiRequest, @Body() body: unknown) { if (!this.deps.operations) problem(503, 'MODULE_UNAVAILABLE', 'Settings unavailable'); const input = parse(z.strictObject({ evidenceReference: z.string().trim().min(3).max(500) }), body); return this.deps.operations.authorizeOutreach(principal(req), input.evidenceReference); }
  @Delete('outreach-authorization') @HttpCode(204)
  async revokeOutreach(@Req() req: ApiRequest) { if (!this.deps.operations) problem(503, 'MODULE_UNAVAILABLE', 'Settings unavailable'); await this.deps.operations.revokeOutreach(principal(req)); }
  @Patch() @HttpCode(204) async patch(@Req() req: ApiRequest, @Body() body: unknown) { if (!this.deps.operations) problem(503, 'MODULE_UNAVAILABLE', 'Settings unavailable'); const input = parse(z.strictObject({ timezone: z.string().max(100).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }).optional(), retentionDays: z.number().int().min(7).max(365).optional() }).refine(v => Object.keys(v).length > 0), body); await this.deps.operations.updateSettings(principal(req), input); }
}
export async function createApp(deps: Dependencies) {
  const logger = pino({ level: deps.config.LOG_LEVEL });
  @Controller('health')
  class HealthController {
    @Get('live') live() { return { status: 'ok', phase: 10, version: '0.3.12', telegramLiveVerified: false }; }
    @Get('ready') async ready() {
      const health = await checkDependencies(deps.config.DATABASE_URL, deps.config.REDIS_URL);
      if (!health.postgres || !health.redis) throw new HttpException({ code: 'DEPENDENCY_UNAVAILABLE', message: 'Required infrastructure unavailable' }, 503);
      return { status: 'ok', dependencies: health };
    }
  }
  @Module({ controllers: [HealthController, AuthController, AccountsController, ContactsController, ListsController, CampaignsController, TargetsController, InvitationsController, JobsController, AnalyticsController, LogsController, SettingsController], providers: [{ provide: dependencies, useValue: deps }, SessionGuard, AdminGuard, EditorGuard] })
  class AppModule {}
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false, bodyParser: false });
  app.setGlobalPrefix('v1', { exclude: ['health/live', 'health/ready'] });
  app.use(helmet());
  app.use(cookieParser());
  app.use((req: ApiRequest, res: Response, next: NextFunction) => {
    req.requestId = randomUUID(); res.setHeader('x-request-id', req.requestId); res.setHeader('Cache-Control', 'no-store');
    const start = performance.now(); const span = tracer.startSpan('HTTP request', { attributes: { 'http.request.method': req.method } });
    res.on('finish', () => { requestCount.inc({ method: req.method, status: res.statusCode }); requestDuration.observe({ method: req.method, status: res.statusCode }, (performance.now() - start) / 1000); span.setAttribute('http.response.status_code', res.statusCode); span.end(); logger.info({ requestId: req.requestId, traceId: span.spanContext().traceId, method: req.method, status: res.statusCode }, 'HTTP request'); });
    next();
  });
  app.useGlobalFilters(new ApiErrors(logger));
  app.useBodyParser('json', { limit: '1mb' });
  app.enableCors({ origin: deps.config.APP_ORIGIN, credentials: true, methods: ['GET', 'POST', 'PATCH', 'DELETE'], allowedHeaders: ['content-type', 'x-csrf-token'] });
  const identity = new FieldCipher(deps.config.DATA_ENCRYPTION_KEY, deps.config.IDENTITY_HMAC_KEY);
  app.use(async (req: ApiRequest, _res: Response, next: NextFunction) => {
    try {
      if (req.path.startsWith('/health/')) return next();
      if (unsafe(req.method)) assertOrigin(req.get('origin'), deps.config.APP_ORIGIN);
      if (!await deps.limiter.consume(`global:${identity.identity(req.ip ?? 'unknown')}`, 120, 60)) problem(429, 'RATE_LIMITED', 'Too many requests');
      next();
    } catch (error) {
      if (error instanceof HttpException) next(error);
      else next(new HttpException({ code: 'RATE_LIMITER_UNAVAILABLE', message: 'Request protection unavailable' }, 503));
    }
  });
  const document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('Smart Telegram Platform').setVersion('0.3.12').addCookieAuth(cookieName(deps.config)).build());
  for (const [path, operations] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      if (typeof operation !== 'object' || operation === null) continue;
      if (!path.startsWith('/health/') && path !== '/v1/auth/login') operation.security = [{ cookie: [] }];
      if (['post', 'patch', 'delete'].includes(method)) {
        operation.parameters = [...(operation.parameters ?? []), { in: 'header', name: 'Origin', required: true, schema: { type: 'string', example: deps.config.APP_ORIGIN } },
          ...(path === '/v1/auth/login' ? [] : [{ in: 'header' as const, name: 'X-CSRF-Token', required: true, schema: { type: 'string' as const } }])];
      }
      operation.description = `${operation.description ?? ''} ${path.includes('/connect') || path.includes('/disconnect') ? 'Phase 3 browser lifecycle: returns 501 OPERATION_UNSUPPORTED.' : ''}`;
    }
  }
  const bodies: Record<string, object> = {
    'post /v1/auth/login': { type: 'object', required: ['email', 'password'], additionalProperties: false, properties: { email: { type: 'string', format: 'email' }, password: { type: 'string', maxLength: 256 } } },
    'post /v1/accounts': { type: 'object', required: ['displayName', 'phone', 'ownershipConfirmed'], additionalProperties: false, properties: { displayName: { type: 'string', minLength: 1, maxLength: 100 }, phone: { type: 'string', pattern: '^\\+[1-9]\\d{6,14}$' }, ownershipConfirmed: { type: 'boolean', enum: [true] } } },
    'patch /v1/accounts/{id}': { type: 'object', minProperties: 1, additionalProperties: false, properties: { displayName: { type: 'string', minLength: 1, maxLength: 100 }, enabled: { type: 'boolean' } } },
  };
  const listing = document.paths['/v1/accounts']?.get;
  if (listing) listing.parameters = [
    { in: 'query', name: 'page', schema: { type: 'integer', minimum: 1, maximum: 100000, default: 1 } },
    { in: 'query', name: 'pageSize', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
    { in: 'query', name: 'status', schema: { type: 'string', enum: ['DISCONNECTED', 'AUTH_REQUIRED', 'AUTHENTICATING', 'CONNECTED', 'SESSION_EXPIRED', 'ACTION_REQUIRED', 'RESTRICTED', 'PAUSED', 'ERROR'] } },
    { in: 'query', name: 'sort', schema: { type: 'string', enum: ['createdAt', 'displayName'], default: 'createdAt' } },
    { in: 'query', name: 'order', schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' } },
  ];
  for (const [key, schema] of Object.entries(bodies)) {
    const [method, path] = key.split(' ');
    const operation = document.paths[path!]?.[method as 'post' | 'patch'];
    if (operation) operation.requestBody = { required: true, content: { 'application/json': { schema } } };
  }
  const extendedBodies = [
    ['post', '/v1/contacts', contactInputSchema], ['patch', '/v1/contacts/{id}', contactPatchSchema], ['patch', '/v1/contacts/{id}/consent', consentInputSchema], ['post', '/v1/contacts/import', importSchema],
    ['post', '/v1/contact-lists', listSchema], ['post', '/v1/campaigns', campaignInputSchema], ['post', '/v1/targets', targetInputSchema],
    ['post', '/v1/contacts/export/jobs', contactExportJobSchema], ['post', '/v1/settings/outreach-authorization', z.strictObject({ evidenceReference: z.string().trim().min(3).max(500) })],
  ] as const;
  for (const [method, path, schema] of extendedBodies) {
    const operation = document.paths[path]?.[method];
    if (operation) operation.requestBody = { required: true, content: { 'application/json': { schema: z.toJSONSchema(schema, { target: 'openapi-3.0', io: 'input', unrepresentable: 'any' }) as object } } };
  }
  SwaggerModule.setup('docs', app, document, { jsonDocumentUrl: 'docs/openapi.json' });
  return app;
}
