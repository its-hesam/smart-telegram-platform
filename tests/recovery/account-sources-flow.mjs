// Run through Node stdin in /app with a migrated, isolated smart_sources_fixture DB.
// Prepend `const fixtureHtml = ...` with tests/browser/account-sources.test.ts's HTML.
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {createDatabase} from './dist/packages/database/src/index.js';
import {FieldCipher} from './dist/packages/shared/src/crypto.js';
import {ProfileVault} from './dist/packages/automation-core/src/profile-vault.js';
import {PersistentBrowserManager} from './dist/packages/automation-core/src/browser-manager.js';
import {AccountSourcesService} from './dist/apps/api/src/account-sources.js';
import {ContactsService} from './dist/apps/api/src/contacts.js';
import {processAccountSources} from './dist/apps/worker/src/account-sources.js';
import {saveMemberContacts} from './dist/packages/shared/src/member-contacts.js';
import readXlsxFile from 'read-excel-file/node';
assert.equal(new URL(process.env.DATABASE_URL).pathname,'/smart_sources_fixture');
const db=createDatabase(process.env.DATABASE_URL), cipher=new FieldCipher(randomBytes(32).toString('hex'),randomBytes(32).toString('hex'));
const archive=await mkdtemp('/tmp/source-drill-'), runtime='/profiles/runtime/source-drill-'+randomUUID();let revoked=false;
class FixtureManager extends PersistentBrowserManager {
 async open(...args){const r=await super.open(...args);if(r.ok)await r.value.page.route('https://web.telegram.org/**',route=>route.fulfill({contentType:'text/html',body:revoked?fixtureHtml.replace('window.membersAllowed=true','window.membersAllowed=false'):fixtureHtml}));return r;}
}
const manager=new FixtureManager(new ProfileVault(archive,runtime,randomBytes(32),true),{headless:true,maxContexts:1});
try{
 const user=await db.adminUser.create({data:{email:'sources-fixture@invalid.test',passwordHash:'unusable',role:'ADMIN'}}), actor={id:user.id,email:user.email,role:'ADMIN'};
 const id=randomUUID();await db.telegramAccount.create({data:{id,displayName:'isolated source fixture',status:'CONNECTED',encryptedPhone:cipher.encrypt('+12025550123',`account:${id}:phone`),identityKey:cipher.identity(id)}});
 const service=new AccountSourcesService(db,cipher), scan=await service.refresh(actor,id);
 await processAccountSources(db,cipher,manager,scan.jobId,'source-drill',new AbortController().signal);
 const catalog=await service.list(id);assert.equal(catalog.job.status,'COMPLETED');assert.equal(catalog.sources.length,2);assert(!JSON.stringify(catalog).includes('"peer"'));
 const group=catalog.sources.find(s=>s.type==='GROUP');assert.equal(group.adminVerified,false);
 const selected=await service.select(actor,id,[group.key]), targetId=selected.targets[0].id;
 const run=await service.extract(actor,targetId,1);await processAccountSources(db,cipher,manager,run.jobId,'source-drill',new AbortController().signal);
 const result=await db.job.findUniqueOrThrow({where:{id:run.jobId}});assert.equal(result.status,'COMPLETED');assert(!JSON.stringify(result.result).includes('Member one'));
 const csv=await service.csv(actor,run.jobId);assert(csv.includes('Member one'));assert(!csv.includes('Member two'));assert(csv.includes('UNKNOWN'));assert(csv.includes('true'));assert.equal(await db.contact.count(),1);let imported=await db.contact.findFirstOrThrow();assert.equal(imported.consentStatus,'UNKNOWN');assert.equal(cipher.decrypt(imported.encryptedTelegramId,'contact:'+imported.id+':telegramId'),'91');await service.importContacts(actor,run.jobId);assert.equal(await db.contact.count(),1);
 const workbook=(await readXlsxFile(await service.xlsx(actor,run.jobId)))[0].data;assert.equal(workbook[1][2],'91');assert.equal(workbook[1][0],'Member one');assert.equal(workbook[1][1],'@fixture_user');assert.equal(cipher.decrypt(imported.encryptedUsername,'contact:'+imported.id+':username'),'fixture_user');assert.equal(result.result.usernameCounts.visible,1);
 const complete=async members=>{const request=await service.extract(actor,targetId,10);await db.job.update({where:{id:request.jobId},data:{status:'RUNNING'}});return saveMemberContacts(db,cipher,request.jobId,{members,partial:false,observedAt:new Date().toISOString()});};
 const contacts=new ContactsService(db,cipher);await contacts.removeRecord(actor,imported.id);assert.equal(await db.contact.count(),0);assert.equal(await db.suppression.count(),0);
 assert.equal((await complete([{reference:'91',displayName:'Member one',username:'@fixture_user'}])).created,1);imported=await db.contact.findFirstOrThrow();
 assert.equal((await complete([{reference:'91',displayName:'Member one',username:'@fixture_user'}])).existing,1);assert.equal(await db.contact.count(),1);
 await db.contact.update({where:{id:imported.id},data:{consentStatus:'OPTED_OUT'}});assert.equal((await complete([{reference:'91',displayName:'Member one',username:'@fixture_user'}])).skipped,1);assert.equal((await db.contact.findUniqueOrThrow({where:{id:imported.id}})).consentStatus,'OPTED_OUT');
 await db.suppression.create({data:{identityKey:cipher.identity('contact:telegramId:93'),reason:'fixture-erasure'}});assert.equal((await complete([{reference:'93',displayName:'Suppressed fixture',username:null}])).skipped,1);assert.equal(await db.contact.count(),1);
 assert.equal((await complete([{reference:'94',displayName:'No username fixture',username:null}])).created,1);let numericOnly=await db.contact.findFirstOrThrow({where:{id:{not:imported.id}}});assert.equal(numericOnly.encryptedUsername,null);assert.equal(cipher.decrypt(numericOnly.encryptedTelegramId,'contact:'+numericOnly.id+':telegramId'),'94');await contacts.removeRecord(actor,numericOnly.id);assert.equal((await complete([{reference:'94',displayName:'No username fixture',username:null}])).created,1);numericOnly=await db.contact.findFirstOrThrow({where:{id:{not:imported.id}}});await contacts.erase(actor,numericOnly.id);assert.equal((await complete([{reference:'94',displayName:'No username fixture',username:null}])).skipped,1);
 revoked=true;const denied=await service.extract(actor,targetId,10);await processAccountSources(db,cipher,manager,denied.jobId,'source-drill',new AbortController().signal);
 const final=await db.job.findUniqueOrThrow({where:{id:denied.jobId}});assert.equal(final.status,'FAILED');assert.equal(final.errorCode,'SOURCE_MEMBERS_UNAVAILABLE');await assert.rejects(service.csv(actor,denied.jobId));
 assert.equal((await db.accountLease.findUniqueOrThrow({where:{accountId:id}})).ownerId,'');
 await contacts.removeRecord(actor,imported.id);assert.equal((await complete([{reference:'91',displayName:'Member one',username:'@fixture_user'}])).skipped,1);assert.equal(await db.contact.count(),0);
 console.log('PASS: real DB/outbox, private-source selection, visible-member CSV/XLSX, automatic encrypted UNKNOWN contacts, idempotency, deduplication, opt-out/suppression preservation and hidden-member refusal');
}finally{await manager.shutdown();await db.$disconnect();for(const p of [archive,runtime]){assert(p.startsWith('/tmp/source-drill-')||p.startsWith('/profiles/runtime/source-drill-'));await rm(p,{recursive:true,force:true});}}
