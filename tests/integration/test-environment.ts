import 'dotenv/config';
let dedicated = false;
try { dedicated = /_test$/.test(new URL(process.env.DATABASE_URL ?? '').pathname); } catch {}
if (!dedicated) throw new Error('Integration tests require a dedicated database whose name ends in _test; never use production data');
