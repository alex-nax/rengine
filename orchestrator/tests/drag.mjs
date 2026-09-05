import assert from 'node:assert/strict';

export async function dragTab(page, tab, target) {
  const source = await tab.boundingBox();
  const destination = await target.boundingBox();
  assert.ok(source && destination, 'Drag endpoints must be visible.');
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  const x = destination.x + destination.width / 2;
  const y = destination.y + destination.height / 2;
  await page.mouse.move(x, y, { steps: 15 });
  await page.mouse.move(x + 2, y + 2);
  await page.mouse.move(x, y);
  await page.mouse.up();
  return destination;
}
