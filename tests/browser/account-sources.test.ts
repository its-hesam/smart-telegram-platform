import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { it, expect } from 'vitest';
import { AccountSourcesUi } from '../../packages/telegram-web-adapter/src/account-sources.js';
it('lists private group/channel UI rows, permits non-owner UI access and bounds member export', async () => {
  const html = `<body><div id="column-left"><button onclick="document.querySelector('#menu').hidden=false">More</button><div id="menu" hidden><button role="menuitem" onclick="location.hash='42';document.querySelector('#menu').hidden=true;render()">Saved Messages</button></div><a class="chatlist-chat" data-peer-id="-111" href="#-111"><div class="user-title"><span class="peer-title">Private fixture group</span></div></a><a class="chatlist-chat" data-peer-id="-222" href="#-222"><div class="user-title"><span class="peer-title">Fixture channel</span></div></a><a class="chatlist-chat" data-peer-id="77"><div class="user-title"><span class="peer-title">Private user</span></div></a></div><div class="chat-info" onclick="profile()"><span class="peer-title" data-peer-id="42">Saved Messages</span><div class="info">0 messages</div></div><div class="chat-info"><span class="peer-title" data-peer-id="-999">Background chat</span><div class="info">6 members</div></div><div id="column-right" hidden></div><script>
    window.memberViews=0;window.membersAllowed=true;const right=document.querySelector('#column-right');
    function render(){const id=location.hash.slice(1)||'42';const h=document.querySelector('.chat-info .peer-title');h.dataset.peerId=id;h.textContent=id==='42'?'Saved Messages':id==='-111'?'Private fixture group':'Fixture channel';document.querySelector('.info').textContent=id==='-111'?'2 members':id==='-222'?'12 subscribers':'0 messages';}
    function profile(){right.hidden=false;const id=location.hash.slice(1);if(id==='91'||id==='92'){right.innerHTML='<button class="sidebar-close-button" onclick="right.hidden=true">Close</button><div class="profile-container"><div class="profile-name"><span class="peer-title" data-peer-id="'+id+'">Member</span></div><div class="row"><div class="row-title">@not_a_username_from_bio</div><div class="row-subtitle">Bio</div></div>'+(id==='91'?'<div class="row"><div class="row-title">Fixture_User</div><div class="row-subtitle">Username</div></div>':'')+'</div>';return;}right.innerHTML='<button class="sidebar-close-button" onclick="right.hidden=true">Close</button>'+(window.membersAllowed&&location.hash!=='#-222'?'<button role="tab" onclick="visibleMembers()">Members</button>':'');}function visibleMembers(){members();right.querySelector('.chat-members-container').className='search-super-container-members';}
    function edit(){right.innerHTML='<button class="sidebar-close-button" onclick="profile()">Back</button><div class="row" role="button" onclick="admins()"><span class="row-title">Administrators</span></div><div class="row" role="button" onclick="members()"><span class="row-title">Members</span></div>';}
    function admins(){right.innerHTML='<button class="sidebar-close-button" onclick="edit()">Back</button><div class="chat-administrators-container"><div class="chatlist-chat" data-peer-id="42"><div class="row-title"><span class="peer-title">Fixture admin</span></div></div></div>';}
    function members(){window.memberViews++;right.innerHTML='<button class="sidebar-close-button" onclick="edit()">Back</button><div class="chat-members-container"><div class="chatlist-chat" data-peer-id="91" onclick="location.hash=91;render()"><div class="row-title"><span class="peer-title"><span class="peer-title-inner">Member one</span><span class="badge">Admin</span></span></div><div class="row-subtitle">last seen recently</div></div><div class="chatlist-chat" data-peer-id="92" onclick="location.hash=92;render()"><div class="row-title"><span class="peer-title">Member two</span></div><div class="row-subtitle">last seen recently</div></div></div>';}
    window.onhashchange=render;document.onkeydown=e=>{if(e.key==='Escape')document.querySelector('#menu').hidden=true;};render();</script></body>`;
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address'); const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage(); await page.goto(origin + '/k/?a11y=1'); const ui = new AccountSourcesUi(page, origin); const check = async () => undefined;
    expect(await ui.self(check)).toBe('42'); const refs = await ui.references(check); expect(refs.refs.map(r => r.peer)).toEqual(['-111', '-222']);
    await page.locator('#column-left .chatlist-chat[data-peer-id="-111"]').evaluate(e => { const r = e.getBoundingClientRect(); const blocker = document.createElement('div'); Object.assign(blocker.style, { position: 'fixed', left: r.x + 'px', top: r.y + 'px', width: r.width + 'px', height: r.height + 'px', zIndex: '9999' }); document.body.append(blocker); });
    expect(await ui.open('-111', check)).toBe('GROUP');
    expect(new URL(page.url()).searchParams.has('source_view')).toBe(true);
    const result = await ui.members('-111', '42', 1, check); expect(result.members).toEqual([{ reference: '91', displayName: 'Member one', username: '@fixture_user', usernameStatus: 'VISIBLE' }]); expect(result.partial).toBe(true);
    expect(await ui.profileUsername('92', check)).toEqual({ username: null, usernameStatus: 'NOT_VISIBLE' });
    await expect(ui.profileUsername('invalid', check)).rejects.toMatchObject({ code: 'SOURCE_PROFILE_UNAVAILABLE' });
    const beforeDenied = await page.evaluate(() => (window as unknown as { memberViews: number }).memberViews);
    await page.evaluate(() => { (window as unknown as { membersAllowed: boolean }).membersAllowed = false; });
    await expect(ui.members('-111', '77', 10, check)).rejects.toMatchObject({ code: 'SOURCE_MEMBERS_UNAVAILABLE' });
    expect(await page.evaluate(() => (window as unknown as { memberViews: number }).memberViews)).toBe(beforeDenied);
    expect(await ui.open('-222', check)).toBe('CHANNEL'); await expect(ui.members('-222', '42', 10, check)).rejects.toMatchObject({ code: 'SOURCE_MEMBERS_UNAVAILABLE' });
    await expect(ui.open('123', check)).rejects.toMatchObject({ code: 'SOURCE_UI_UNSUPPORTED' });
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 30000);

it('reads the current account username from Settings after verifying its Saved Messages ID', async () => {
  const html = `<body><div id="column-left"><button onclick="document.querySelector('#menu').hidden=false">More</button><div id="menu" hidden><button role="menuitem" onclick="document.querySelector('#settings').hidden=false;document.querySelector('#menu').hidden=true">Settings</button></div><div id="settings" class="profile-container" hidden><div class="profile-name"><span class="peer-title" data-peer-id="77">Current account</span></div><div class="row"><div class="row-title">Own_Fixture</div><div class="row-subtitle">Username</div></div></div></div><div class="chat-info"><span class="peer-title" data-peer-id="77">Saved Messages</span></div></body>`;
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address'); const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch();
  try { const page = await browser.newPage(); await page.goto(origin + '/k/#77'); expect(await new AccountSourcesUi(page, origin).profileUsername('77', async () => undefined)).toEqual({ username: '@own_fixture', usernameStatus: 'VISIBLE' }); }
  finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
