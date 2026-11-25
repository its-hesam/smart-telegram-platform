import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { it, expect } from 'vitest';
import { TelegramLoginUi } from '../../packages/telegram-web-adapter/src/login.js';
it('drives phone, rejected OTP, valid OTP, rejected 2FA and successful UI login without Telegram APIs', async () => {
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`
    <body class="has-auth-pages"><main id="auth"><button onclick="phone()">Log in by phone number</button></main>
    <div id="page-chats" style="display:none"><nav id="column-left" role="navigation">Chats</nav></div>
    <script>
    const a=document.querySelector('#auth');
    function phone(){a.innerHTML='<label>Phone Number<div contenteditable="true" role="textbox" aria-label="Phone Number"></div></label><button onclick="code()">Next</button>';}
    function code(){a.innerHTML='<input aria-label="Login code" autocomplete="one-time-code" maxlength="5"><div role="alert"></div><button aria-label="Edit" onclick="phone()">Edit</button>';a.querySelector('input').oninput=e=>{if(e.target.value.length===5){if(e.target.value==='12345') password();else {a.querySelector('[role=alert]').textContent='Invalid code';e.target.value='';}}};}
    function password(){a.innerHTML='<input name="notsearch_password" type="password"><div role="alert"></div><button onclick="login()">Next</button>';}
    function login(){if(a.querySelector('input').value==='fixture-2fa'){a.remove();document.body.className='';document.querySelector('#page-chats').style.display='block';}else a.querySelector('[role=alert]').textContent='Invalid password';}
    </script></body>`); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture address missing');
  const origin = `http://127.0.0.1:${address.port}`; const browser = await chromium.launch();
  try {
    const page = await browser.newPage(); await page.goto(origin); const ui = new TelegramLoginUi(page, origin);
    expect(await ui.observe()).toBe('QR'); await ui.sendPhone('+12025550123'); expect(await ui.observe()).toBe('CODE');
    await expect(ui.sendCode('1234')).rejects.toThrow('LOGIN_CODE_LENGTH');
    await ui.sendCode('00000'); expect(await ui.issue()).toBe('TELEGRAM_CODE_INVALID'); await ui.sendPhone('+12025550123'); expect(await ui.observe()).toBe('CODE');
    await ui.sendCode('12345'); expect(await ui.observe()).toBe('PASSWORD');
    await ui.sendPassword('wrong-fixture'); expect(await ui.issue()).toBe('TELEGRAM_PASSWORD_INVALID');
    await ui.sendPassword('fixture-2fa'); expect(await ui.observe()).toBe('CONNECTED');
    await expect(new TelegramLoginUi(page).observe()).rejects.toThrow('LOGIN_ORIGIN_REJECTED');
    await page.goto(origin); await ui.sendPhone('+12025550123');
    await page.locator('input').evaluate(el => el.after(el.cloneNode(true)));
    await expect(ui.sendCode('12345')).rejects.toThrow('LOGIN_UI_UNSUPPORTED');
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 30000);
