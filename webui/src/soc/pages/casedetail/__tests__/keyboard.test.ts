/** The ONE single-key shortcut guard (Round 12 review): letters belong to the control. */
import { afterEach, describe, expect, it } from 'vitest';

import { hasOpenPicker, isLetterConsumer, shortcutBlocked } from '../keyboard';

function el(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host.firstElementChild as HTMLElement;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('shortcut guard', () => {
  it('blocks text entry and every control that consumes letters itself', () => {
    expect(isLetterConsumer(el('<input />'))).toBe(true);
    expect(isLetterConsumer(el('<textarea></textarea>'))).toBe(true);
    expect(isLetterConsumer(el('<button role="combobox">Severity</button>'))).toBe(true);
    expect(isLetterConsumer(el('<div role="menu"><button role="menuitem">Reinvestigate</button></div>').firstElementChild)).toBe(true);
    expect(isLetterConsumer(el('<div role="radiogroup"><button role="radio">FP</button></div>').firstElementChild)).toBe(true);
    expect(isLetterConsumer(el('<div role="listbox"><div role="option">Critical</div></div>').firstElementChild)).toBe(true);
  });

  it('lets a plain button, a queue row or the page body through', () => {
    expect(isLetterConsumer(el('<button>Open case</button>'))).toBe(false);
    expect(isLetterConsumer(document.body)).toBe(false);
    expect(isLetterConsumer(null)).toBe(false);
  });

  it('yields while a Select or menu is open anywhere', () => {
    expect(hasOpenPicker()).toBe(false);
    el('<div role="listbox" data-state="open"></div>');
    expect(hasOpenPicker()).toBe(true);
    expect(shortcutBlocked({ target: document.body })).toBe(true);
  });
});
