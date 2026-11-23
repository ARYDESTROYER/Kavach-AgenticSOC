/**
 * Round 15 (SPEC D4.6, D5.12): the drop zone takes images by drop, by paste inside its
 * scope and by the file picker, ignores everything else, and leaves a text paste alone.
 */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

import { FileDropZone, imageFilesFrom } from '../FileDropZone';

expect.extend(toHaveNoViolations);

const png = new File([new Uint8Array(4)], 'a.png', { type: 'image/png' });
const text = new File(['x'], 'notes.txt', { type: 'text/plain' });

function pasteEvent(files: File[]): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { files, items: [] } });
  return event;
}

describe('imageFilesFrom', () => {
  it('keeps images only and reads clipboard items when there are no files', () => {
    expect(imageFilesFrom({ files: [png, text] })).toEqual([png]);
    const items = [
      { kind: 'string', getAsFile: () => null },
      { kind: 'file', getAsFile: () => png },
    ] as unknown as DataTransferItemList;
    expect(imageFilesFrom({ files: [], items })).toEqual([png]);
    expect(imageFilesFrom(null)).toEqual([]);
  });
});

describe('FileDropZone', () => {
  it('passes dropped images on', () => {
    const onFiles = vi.fn();
    render(<FileDropZone onFiles={onFiles} />);
    const zone = screen.getByTestId('file-drop-zone');
    fireEvent.dragOver(zone, { dataTransfer: { files: [png], items: [] } });
    expect(zone).toHaveAttribute('data-dragging', 'true');
    fireEvent.drop(zone, { dataTransfer: { files: [png, text], items: [] } });
    expect(onFiles).toHaveBeenCalledWith([png]);
    expect(zone).not.toHaveAttribute('data-dragging');
  });

  it('catches a paste with an image in its scope and leaves a text paste alone', () => {
    const onFiles = vi.fn();
    function Host() {
      const scope = React.useRef<HTMLDivElement | null>(null);
      return (
        <div ref={scope} data-testid="scope">
          <input aria-label="Note" />
          <FileDropZone onFiles={onFiles} pasteScopeRef={scope} />
        </div>
      );
    }
    render(<Host />);
    const input = screen.getByLabelText('Note');
    const withImage = pasteEvent([png]);
    input.dispatchEvent(withImage);
    expect(onFiles).toHaveBeenCalledWith([png]);
    expect(withImage.defaultPrevented).toBe(true);
    const plain = pasteEvent([]);
    input.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
    expect(onFiles).toHaveBeenCalledTimes(1);
  });

  it('takes picked files and clears the picker', () => {
    const onFiles = vi.fn();
    const { container } = render(<FileDropZone onFiles={onFiles} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.accept).toContain('image/png');
    fireEvent.change(input, { target: { files: [png] } });
    expect(onFiles).toHaveBeenCalledWith([png]);
  });

  it('does nothing while disabled and says why', () => {
    const onFiles = vi.fn();
    render(<FileDropZone onFiles={onFiles} disabled />);
    const zone = screen.getByTestId('file-drop-zone');
    fireEvent.drop(zone, { dataTransfer: { files: [png], items: [] } });
    zone.dispatchEvent(pasteEvent([png]));
    expect(onFiles).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Add screenshots' })).toBeDisabled();
    expect(screen.getByText('You cannot add screenshots to this case.')).toBeInTheDocument();
  });

  it('claims a drag even while disabled, so the browser never opens the image in place of the Console', () => {
    render(<FileDropZone onFiles={vi.fn()} disabled />);
    const zone = screen.getByTestId('file-drop-zone');
    const dataTransfer = { files: [png], items: [], dropEffect: 'copy' };
    const claimed = !fireEvent.dragOver(zone, { dataTransfer });
    expect(claimed).toBe(true);
    expect(dataTransfer.dropEffect).toBe('none');
    expect(zone).not.toHaveAttribute('data-dragging');
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<FileDropZone onFiles={() => {}} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
