'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Upload, Download, Users, RefreshCw } from 'lucide-react';
import { api, errorText, ApiError } from '../lib/api';
import { Button } from './ui/button';
import type { User } from './dashboard';
import { AudienceTools, ContactEdit } from './contact-tools';

type Contact = { id: string; displayName: string; username: string | null; phone: string | null; telegramId: string | null; suppressed: boolean; tags: string[]; notes: string | null };
type List = { id: string; name: string; _count: { members: number } };
type ExportJob = { id: string; status: string; progress: number; processed: number; totalItems: number | null; errorCode: string | null };
const exportLabels: Record<string, string> = { PENDING: 'در صف', RUNNING: 'در حال تهیه', COMPLETED: 'آماده', FAILED: 'ناتمام', CANCELLED: 'لغوشده', UNKNOWN: 'نیاز به بررسی' };

export function ContactsPanel({ user }: { user: User }) {
  const [editing, setEditing] = useState<Contact | null>(null);
  const client = useQueryClient();
  const [page, setPage] = useState(1);
  const [listId, setListId] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [listName, setListName] = useState('');
  const [notice, setNotice] = useState('');
  const [exportJobId, setExportJobId] = useState<string | null>(null);
  const [exportFormat, setExportFormat] = useState<'csv' | 'xlsx'>('csv');

  const contacts = useQuery({ queryKey: ['contacts', page, listId], queryFn: () => api<{ data: Contact[]; total: number }>(`/contacts?page=${page}&pageSize=20${listId ? `&listId=${listId}` : ''}`) });
  const lists = useQuery({ queryKey: ['lists'], queryFn: () => api<List[]>('/contact-lists') });
  const refresh = () => { void client.invalidateQueries({ queryKey: ['contacts'] }); void client.invalidateQueries({ queryKey: ['lists'] }); };
  const createList = useMutation({ mutationFn: () => api('/contact-lists', { method: 'POST', body: { name: listName } }), onSuccess: () => { setListName(''); refresh(); } });
  const create = useMutation({ mutationFn: (body: unknown) => api('/contacts', { method: 'POST', body }), onSuccess: () => { setFormOpen(false); refresh(); } });
  const suppress = useMutation({ mutationFn: (id: string) => api(`/contacts/${id}/suppress`, { method: 'POST' }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => api(`/contacts/${id}/record`, { method: 'DELETE' }), onSuccess: refresh });
  const erase = useMutation({ mutationFn: (id: string) => api(`/contacts/${id}`, { method: 'DELETE' }), onSuccess: refresh });
  const importer = useMutation({ mutationFn: (body: unknown) => api<{ imported: number; duplicates: number; errors: { row: number; code: string }[] }>('/contacts/import', { method: 'POST', body }), onSuccess: result => { setNotice(`${result.imported} مخاطب ثبت شد؛ ${result.duplicates} تکراری و ${result.errors.length} ردیف رد شد.${result.errors.length ? ` ردیف‌ها: ${result.errors.map(e => e.row).join('، ')}` : ''}`); refresh(); } });
  const startExport = useMutation({ mutationFn: (format: 'csv' | 'xlsx') => api<{ jobId: string }>('/contacts/export/jobs', { method: 'POST', body: { format } }), onSuccess: (result, format) => { setExportFormat(format); setExportJobId(result.jobId); setNotice('خروجی در صف قرار گرفت؛ درصد پیشرفت همین‌جا نمایش داده می‌شود.'); } });
  const exportJob = useQuery<ExportJob>({ queryKey: ['export-job', exportJobId], queryFn: () => api<ExportJob>(`/contacts/export/jobs/${exportJobId}`), enabled: Boolean(exportJobId), refetchInterval: query => ['PENDING', 'RUNNING'].includes(query.state.data?.status ?? '') ? 1000 : false });
  const resumeExport = useMutation({ mutationFn: (id: string) => api(`/contacts/export/jobs/${id}/resume`, { method: 'POST' }), onSuccess: () => { void exportJob.refetch(); } });

  if (user.role === 'VIEWER') return <div className="panel"><h1>مخاطبان و لیست‌ها</h1><p className="muted">مشاهده اطلاعات شخصی مخاطبان به نقش مدیر یا اپراتور نیاز دارد.</p></div>;

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 512000) { setNotice('حجم فایل باید کمتر از ۵۱۲ کیلوبایت باشد.'); return; }
    const format = file.name.toLowerCase().endsWith('.xlsx') ? 'xlsx' : 'csv';
    let content: string;
    if (format === 'csv') content = await file.text();
    else { const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); content = btoa(binary); }
    importer.mutate({ format, content, ...(listId ? { listId } : {}) });
  };
  const downloadExport = () => { if (!exportJobId) return; const link = document.createElement('a'); link.href = `/v1/contacts/export/jobs/${exportJobId}/file`; link.click(); };
  const exportStatus = exportJob.data?.status ?? 'PENDING';
  const exportError = exportJob.data?.errorCode ?? null;

  return <>
    <div className="page-heading">
      <div><p className="overline">CONTACT OPERATIONS</p><h1>مخاطبان و لیست‌ها</h1><p className="muted">مدیریت مخاطبان، لیست‌ها و خروجی کامل بدون سقف</p></div>
      <div className="flex gap-2">
        <Button variant="outline" onClick={() => document.getElementById('contact-import')?.click()} disabled={importer.isPending}><Upload size={16}/> ورود فایل</Button>
        <input id="contact-import" type="file" accept=".csv,.xlsx" hidden onChange={e => { void importFile(e.target.files?.[0]); e.target.value = ''; }}/>
        {user.role === 'ADMIN' && <><Button variant="outline" disabled={startExport.isPending} onClick={() => startExport.mutate('csv')}><Download size={16}/> CSV</Button><Button variant="outline" disabled={startExport.isPending} onClick={() => startExport.mutate('xlsx')}>Excel</Button></>}
        <Button onClick={() => { create.reset(); setFormOpen(v => !v); }}><Plus size={16}/> مخاطب جدید</Button>
      </div>
    </div>

    <div className="info-banner mb-6"><Users size={22}/><div><strong>خروجی غیرهم‌زمان و بدون سقف</strong><p>خروجی در پس‌زمینه با صفحه‌بندی و پردازش دسته‌ای تهیه می‌شود و پیشرفت آن قابل مشاهده است. منع ارسال همچنان اعمال می‌شود و مخاطب مسدود در ارسال‌ها کنار گذاشته می‌شود.</p></div></div>

    {exportJobId && <div className="panel mb-6" role="status">
      <div className="table-toolbar"><strong>خروجی {exportFormat.toUpperCase()}</strong><span className="muted">{exportLabels[exportStatus] ?? exportStatus}</span><span className="muted" dir="ltr">{exportJob.data?.processed ?? 0}{exportJob.data?.totalItems ? ` / ${exportJob.data.totalItems}` : ''}</span><span className="muted">{exportJob.data?.progress ?? 0}%</span></div>
      <progress max={100} value={exportJob.data?.progress ?? 0} style={{ width: '100%' }}/>
      <div className="flex gap-2 mt-4">
        {exportStatus === 'COMPLETED' && <Button onClick={downloadExport}>دریافت فایل</Button>}
        {['FAILED', 'CANCELLED', 'UNKNOWN'].includes(exportStatus) && <Button variant="outline" disabled={resumeExport.isPending} onClick={() => resumeExport.mutate(exportJobId)}>ادامهٔ خروجی</Button>}
        <Button variant="outline" onClick={() => setExportJobId(null)}>بستن</Button>
      </div>
      {exportError && <div className="error-notice">{errorText(new ApiError(exportError, 409))}</div>}
    </div>}

    {notice && <div role="status" className="info-banner mb-5">{notice}</div>}
    {[contacts.error, lists.error, create.error, createList.error, suppress.error, remove.error, erase.error, importer.error, startExport.error, exportJob.error].filter(Boolean).map((error, index) => <div className="error-notice" role="alert" key={index}>{errorText(error)}</div>)}

    {formOpen && <div className="panel mb-6"><h2>ثبت مخاطب</h2><form onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); create.mutate({ displayName: data.get('displayName'), ...(data.get('username') ? { username: data.get('username') } : {}), ...(data.get('phone') ? { phone: data.get('phone') } : {}), tags: String(data.get('tags') ?? '').split(',').map(s => s.trim()).filter(Boolean), listIds: listId ? [listId] : [] }); }}>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6"><label>نام نمایشی<input name="displayName" required maxLength={100}/></label><label>نام کاربری تلگرام<input name="username" dir="ltr" placeholder="username"/></label><label>شماره<input name="phone" dir="ltr" placeholder="+98912…"/></label><label>برچسب‌ها، جدا با ویرگول<input name="tags"/></label></div>
      <Button className="mt-5" disabled={create.isPending}>ثبت مخاطب</Button>
    </form></div>}

    <div className="panel mb-6">
      <div className="table-toolbar">
        <select aria-label="فیلتر لیست" value={listId} onChange={e => { setListId(e.target.value); setPage(1); }}><option value="">همه لیست‌ها</option>{lists.data?.map(list => <option key={list.id} value={list.id}>{list.name} ({list._count.members})</option>)}</select>
        <form className="flex gap-2 mr-auto" onSubmit={e => { e.preventDefault(); createList.mutate(); }}><input aria-label="نام لیست جدید" placeholder="نام لیست جدید" value={listName} onChange={e => setListName(e.target.value)} required maxLength={100}/><Button variant="outline" disabled={createList.isPending}>ساخت لیست</Button></form>
        <Button variant="outline" aria-label="تازه‌سازی" onClick={() => { void contacts.refetch(); }}><RefreshCw size={16}/></Button>
      </div>
      <div className="table-scroll"><table><thead><tr><th>مخاطب</th><th>شناسهٔ عددی تلگرام</th><th>نام کاربری / شماره</th><th>وضعیت</th><th>برچسب‌ها</th><th>عملیات</th></tr></thead><tbody>{contacts.data?.data.map(row => <tr key={row.id}><td><strong>{row.displayName}</strong></td><td dir="ltr">{row.telegramId ?? '—'}</td><td dir="ltr">{row.username ? `@${row.username}` : row.phone ?? '—'}</td><td><span className={`status ${row.suppressed ? 'status-restricted' : 'status-connected'}`}>{row.suppressed ? 'منع ارسال' : 'فعال'}</span></td><td>{row.tags.join('، ') || '—'}</td><td><div className="flex gap-2"><Button variant="outline" onClick={() => setEditing(row)}>ویرایش</Button><Button variant="outline" disabled={suppress.isPending || row.suppressed} onClick={() => suppress.mutate(row.id)}>منع ارسال</Button>{user.role === 'ADMIN' && <Button variant="destructive" disabled={remove.isPending} onClick={() => { if (window.confirm(`مخاطب «${row.displayName}» از فهرست حذف شود؟ استخراج دوباره مجاز می‌ماند.`)) remove.mutate(row.id); }}>حذف مخاطب</Button>}</div></td></tr>)}</tbody></table>{!contacts.isPending && !contacts.data?.data.length && <p className="empty muted">مخاطبی در این فیلتر وجود ندارد.</p>}</div>
      <div className="pagination"><span>{contacts.data?.total ?? '—'} مخاطب</span><div className="flex gap-3"><Button variant="outline" disabled={page === 1} onClick={() => setPage(v => v - 1)}>قبل</Button><span>{page}</span><Button variant="outline" disabled={!contacts.data || page * 20 >= contacts.data.total} onClick={() => setPage(v => v + 1)}>بعد</Button></div></div>
    </div>

    <AudienceTools contacts={contacts.data?.data ?? []} lists={lists.data ?? []} admin={user.role === 'ADMIN'} onDone={refresh}/>
    {editing && <ContactEdit contact={editing} erasePending={erase.isPending} onErase={user.role === 'ADMIN' ? () => { if (window.confirm('حذف دائمی و منع ورود مجدد این مخاطب انجام شود؟ برای پاک‌کردن تستی، از حذف مخاطب استفاده کنید.')) erase.mutate(editing.id, { onSuccess: () => setEditing(null) }); } : undefined} onClose={() => setEditing(null)} onDone={refresh}/>}
    <p className="small muted">ستون‌های فایل: displayName، username یا phone و tags. ورود فایل به‌صورت دسته‌ای پردازش می‌شود. برای خروجی بزرگ از دکمهٔ CSV یا Excel استفاده کنید؛ فایل در پس‌زمینه ساخته می‌شود.</p>
  </>;
}
