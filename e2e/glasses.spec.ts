import { expect, test, type Page } from '@playwright/test';

/**
 * The four properties the Meta Ray-Ban Display runtime makes non-negotiable:
 * nothing scrolls, every control is reachable with arrow keys alone, focus is
 * always visible, and playback degrades instead of breaking.
 */

/** Mints a pairing code through the control API and types it with the D-pad. */
async function pair(page: Page): Promise<void> {
  const response = await page.request.post('/api/pair');
  const { code } = (await response.json()) as { code: string };

  await page.goto('/glasses/');
  await expect(page.locator('#screen-pair')).toBeVisible();

  // Left/Right selects the position, Up/Down changes the digit.
  for (let position = 0; position < 6; position += 1) {
    const target = Number(code[position]);
    for (let step = 0; step < target; step += 1) await page.keyboard.press('ArrowUp');
    if (position < 5) await page.keyboard.press('ArrowRight');
  }

  // Array form: one expected string per .digit element.
  await expect(page.locator('#digits .digit')).toHaveText(code.split(''));
  await page.keyboard.press('Enter');
  await expect(page.locator('#screen-list')).toBeVisible();
  // The list loads asynchronously; it must take focus once rows exist, or the
  // wearer would be pressing keys at nothing.
  await expect(page.locator('.stream-row').first()).toBeFocused();
}

test('the document never scrolls, on any screen', async ({ page }) => {
  await pair(page);

  for (const screen of ['#screen-list', '#screen-viewer']) {
    if (screen === '#screen-viewer') await page.keyboard.press('Enter');
    await expect(page.locator(screen)).toBeVisible();

    const overflow = await page.evaluate(() => ({
      bodyX: document.body.scrollWidth - document.body.clientWidth,
      bodyY: document.body.scrollHeight - document.body.clientHeight,
      docX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      docY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
    }));

    expect(overflow.width).toBe(600);
    expect(overflow.height).toBe(600);
    expect(overflow.bodyX, `${screen} scrolls horizontally`).toBeLessThanOrEqual(0);
    expect(overflow.bodyY, `${screen} scrolls vertically`).toBeLessThanOrEqual(0);
    expect(overflow.docX).toBeLessThanOrEqual(0);
    expect(overflow.docY).toBeLessThanOrEqual(0);
  }
});

test('every focusable is reachable by arrow keys alone, from the first element', async ({ page }) => {
  await page.goto('/glasses/');

  // Pair screen: Left/Right walks the six digits and the confirm button.
  const reached = new Set<string>();
  const expected = await page.locator('#screen-pair .focusable').count();

  for (let step = 0; step < expected * 2; step += 1) {
    const id = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      if (!active) return 'none';
      return active.dataset.index ?? active.dataset.action ?? active.tagName;
    });
    reached.add(id);
    await page.keyboard.press('ArrowRight');
  }

  expect(reached.size, 'not every control on the pair screen was reachable').toBe(expected);
  expect(reached.has('none')).toBe(false);

  // Stream list: Up/Down walks the rows on the page.
  await pair(page);
  const rows = await page.locator('.stream-row').count();
  const visited = new Set<string>();
  for (let step = 0; step < rows; step += 1) {
    visited.add(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.streamId ?? 'none'));
    await page.keyboard.press('ArrowDown');
  }
  expect(visited.size).toBe(rows);
  expect(visited.has('none')).toBe(false);
});

test('focus is always visible and never lost to the body', async ({ page }) => {
  await pair(page);

  for (const key of ['ArrowDown', 'ArrowDown', 'ArrowRight', 'ArrowUp', 'Enter']) {
    await page.keyboard.press(key);

    const focus = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      if (!active || active === document.body) return null;
      const style = getComputedStyle(active);
      return {
        focusable: active.classList.contains('focusable'),
        matchesFocus: active.matches(':focus'),
        // Read the ring, not the border: border-color animates over 300ms, so
        // sampling it immediately after a keypress catches it mid-transition.
        ring: style.boxShadow,
      };
    });

    expect(focus, `focus was lost after ${key}`).not.toBeNull();
    expect(focus?.focusable).toBe(true);
    expect(focus?.matchesFocus).toBe(true);
    expect(focus?.ring, `no focus ring after ${key}`).toContain('0, 212, 255');
  }
});

test('the stream list paginates instead of scrolling, and Left/Right moves pages', async ({ page }) => {
  await pair(page);

  const total = 7; // the stub serves 7 streams
  const firstPage = await page.locator('.stream-row').count();
  expect(firstPage).toBeGreaterThan(0);
  expect(firstPage).toBeLessThan(total);
  await expect(page.locator('#list-pager')).toHaveText(`1–${firstPage} of ${total}`);

  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#list-pager')).toContainText(`of ${total}`);
  await expect(page.locator('#list-pager')).not.toHaveText(`1–${firstPage} of ${total}`);

  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#list-pager')).toHaveText(`1–${firstPage} of ${total}`);
});

test('stepping off the last row of a page turns the page, rather than wrapping', async ({ page }) => {
  await pair(page);

  const total = 7;
  const perPage = await page.locator('.stream-row').count();
  await expect(page.locator('#list-pager')).toHaveText(`1–${perPage} of ${total}`);

  // Down through the whole first page: the last press must reach stream 6, not
  // wrap back to stream 1 and strand the overflow behind a Right press.
  for (let step = 0; step < perPage; step += 1) await page.keyboard.press('ArrowDown');

  await expect(page.locator('#list-pager')).toHaveText(`${perPage + 1}–${total} of ${total}`);
  await expect(page.locator('.stream-row').first()).toBeFocused();

  // And back up over the boundary, onto the last row of the first page.
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#list-pager')).toHaveText(`1–${perPage} of ${total}`);
  await expect(page.locator('.stream-row').last()).toBeFocused();
});

test('Escape returns from the viewer to the list', async ({ page }) => {
  await pair(page);
  await page.keyboard.press('Enter');
  await expect(page.locator('#screen-viewer')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator('#screen-list')).toBeVisible();
});

test('playback falls back to the relay when MSE and native HLS are unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    // Simulate a runtime with no Media Source Extensions and no native HLS.
    delete (window as unknown as Record<string, unknown>).MediaSource;
    const original = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function patched(type: string) {
      if (type.includes('mpegurl')) return '';
      return original.call(this, type);
    };
  });

  await pair(page);
  await page.keyboard.press('Enter');

  await expect(page.locator('#viewer-note')).toHaveAttribute('data-strategy', 'relay');
  await expect(page.locator('#viewer-note')).toContainText('frame relay');
});

test('a revoked device is sent back to the pairing screen', async ({ page }) => {
  await pair(page);

  const devices = await (await page.request.get('/api/devices')).json();
  await page.request.delete(`/api/devices/${devices.devices[0].id}`);

  await page.reload();
  await expect(page.locator('#screen-pair')).toBeVisible();
  await expect(page.locator('#pair-status')).toContainText('Pairing expired');
});

test('the glasses API never returns a stream key', async ({ page }) => {
  await pair(page);
  const token = await page.evaluate(() => window.localStorage.getItem('mrbd.device_token'));

  const response = await page.request.get('/api/glasses/streams', {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(await response.text()).not.toContain('key-li-alpha');
});
