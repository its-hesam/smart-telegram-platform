import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {createDatabase} from './dist/packages/database/src/index.js';
import {FieldCipher} from './dist/packages/shared/src/crypto.js';
import {ProfileVault} from './dist/packages/automation-core/src/profile-vault.js';
import {PersistentBrowserManager} from './dist/packages/automation-core/src/browser-manager.js';
import {TelegramLoginService} from './dist/apps/worker/src/telegram-login.js';
import {acquireLease} from './dist/packages/automation-core/src/lease.js';
import {TelegramLoginUi} from './dist/packages/telegram-web-adapter/src/login.js';
assert.equal(new URL(process.env.DATABASE_URL).pathname,'/smart_login_fixture');
const db=createDatabase(process.env.DATABASE_URL), run=randomUUID();
const archive=await mkdtemp('/tmp/login-drill-'), runtime='/profiles/runtime/login-drill-'+run;
const html=`<body class="has-auth-pages"><main id="auth"><button onclick="phone()">Log in by phone number</button></main><div id="page-chats" style="display:none"><nav id="column-left" role="navigation">Chats</nav></div><script>
const a=document.querySelector('#auth'); function phone(){a.innerHTML='<div contenteditable="true" role="textbox" aria-label="Phone Number"></div><button onclick="code()">Next</button>';} function code(){a.innerHTML='<input autocomplete="one-time-code" maxlength="5"><div role="alert"></div>';a.querySelector('input').oninput=e=>{if(e.target.value.length===5){if(e.target.value==='12345') password();else{a.querySelector('[role=alert]').textContent='Invalid code';e.target.value='';}}};}function password(){a.innerHTML='<input name="notsearch_password" type="password"><div role="alert"></div><button onclick="login()">Next</button>';}function login(){if(a.querySelector('input').value==='fixture-2fa'){localStorage.setItem('fixture-signed-in','true');connected();}else a.querySelector('[role=alert]').textContent='Invalid password';}function connected(){a.remove();document.body.className='';document.querySelector('#page-chats').style.display='block';}if(localStorage.getItem('fixture-signed-in'))connected();</script></body>`;
class FixtureManager extends PersistentBrowserManager {
 async open(...args){const r=await super.open(...args);if(r.ok)await r.value.page.route('https://web.telegram.org/**',route=>route.fulfill({contentType:'text/html',body:html}));return r;}
}
const cipher=new FieldCipher(randomBytes(32).toString('hex'),randomBytes(32).toString('hex'));
const manager=new FixtureManager(new ProfileVault(archive,runtime,randomBytes(32),true),{headless:true,maxContexts:1});
const service=new TelegramLoginService(db,manager,cipher,'drill',new AbortController().signal);
try {
 const user=await db.adminUser.create({data:{email:'fixture@invalid.test',role:'ADMIN',passwordHash:'unusable-fixture-hash'}});
 const sessionId=randomBytes(32).toString('hex'), secondSession=randomBytes(32).toString('hex');
 for(const tokenHash of [sessionId,secondSession])await db.authSession.create({data:{userId:user.id,tokenHash,expiresAt:new Date(Date.now()+3600000)}});
 const accountId=randomUUID();await db.telegramAccount.create({data:{id:accountId,displayName:'isolated login fixture',encryptedPhone:cipher.encrypt('+12025550123',`account:${accountId}:phone`),identityKey:cipher.identity(accountId)}});
 const execute=command=>service.execute({accountId,actorId:user.id,sessionId,command});
 let view=await execute({action:'start'});assert.equal(view.step,'OPENING');
 for(let n=0;n<100&&view.step==='OPENING';n++){await new Promise(r=>setTimeout(r,100));view=await execute({action:'status',flowId:view.flowId});}
 assert.equal(view.step,'CODE');
 await assert.rejects(service.execute({accountId,actorId:user.id,sessionId:secondSession,command:{action:'status',flowId:view.flowId}}),e=>e.code==='LOGIN_FLOW_NOT_FOUND');
 const same=await execute({action:'start'});assert.equal(same.flowId,view.flowId);
 view=await execute({action:'code',flowId:view.flowId,code:'00000'});assert.equal(view.issue,'TELEGRAM_CODE_INVALID');
 view=await execute({action:'code',flowId:view.flowId,code:'12345'});assert.equal(view.step,'PASSWORD');
 view=await execute({action:'password',flowId:view.flowId,password:'wrong-fixture'});assert.equal(view.issue,'TELEGRAM_PASSWORD_INVALID');
 view=await execute({action:'password',flowId:view.flowId,password:'fixture-2fa'});assert.equal(view.step,'CONNECTED');
 assert.equal((await db.telegramAccount.findUniqueOrThrow({where:{id:accountId}})).status,'CONNECTED');
 assert.equal((await db.accountLease.findUniqueOrThrow({where:{accountId}})).ownerId,'');
 const bytes=await readFile(archive+'/'+accountId+'.enc');assert.equal(bytes.subarray(0,4).toString(),'STP1');assert(!bytes.includes(Buffer.from('fixture-signed-in')));
 const audits=JSON.stringify(await db.auditLog.findMany());assert(!audits.includes('12345'));assert(!audits.includes('fixture-2fa'));
 const lease=await acquireLease(db,accountId,'restore-drill');const restored=await manager.open(accountId,lease,new AbortController().signal);assert(restored.ok);
 await restored.value.page.goto('https://web.telegram.org/k/?a11y=1');assert.equal(await new TelegramLoginUi(restored.value.page).observe(),'CONNECTED');await manager.close(accountId);
 console.log('PASS: real DB/lease, sandboxed browser, phone/code/2FA errors and success, session binding, encrypted seal and browser-profile restoration; all Telegram requests replaced by explicit fixture');
}finally{await service.close();await manager.shutdown();await db.$disconnect();for(const p of [archive,runtime]){assert(p.startsWith('/tmp/login-drill-')||p.startsWith('/profiles/runtime/login-drill-'));await rm(p,{recursive:true,force:true});}}
