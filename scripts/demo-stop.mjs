import { readFile } from 'node:fs/promises';
const config = JSON.parse(await readFile(new URL('../.demo/config.json', import.meta.url), 'utf8'));
const result = await fetch('http://127.0.0.1:3002/stop', { method: 'POST', headers: { 'x-demo-control': config.controlToken } });
if (!result.ok) throw new Error('Demo stop rejected');
console.log('Local demo is stopping; its isolated data remains in .demo/');
