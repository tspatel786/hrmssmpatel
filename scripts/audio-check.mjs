import { chromium } from '@playwright/test';
for (const args of [[], ['--autoplay-policy=no-user-gesture-required']]) {
  const b = await chromium.launch({ args });
  const p = await b.newPage();
  await p.setContent('<button id=x>x</button><script>window.ctx=null;document.addEventListener("pointerdown",()=>{window.ctx=new AudioContext();window.ctx.resume()})</script>');
  await p.click('#x');
  await p.waitForTimeout(500);
  console.log(JSON.stringify(args), await p.evaluate(() => window.ctx?.state));
  await b.close();
}
