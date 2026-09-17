import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import TaskVisualPreviews from './TaskVisualPreviews';

const asset = (id: string) => `https://github.com/user-attachments/assets/${id}`;

describe('TaskVisualPreviews', () => {
  it('renders images with originals, videos with controls, titles and descriptions', () => {
    const { container } = render(<TaskVisualPreviews previews={[
      { type: 'image', title: 'Settings dialog', description: 'Dialog at desktop width', url: asset('image') },
      { type: 'video', title: 'Checkout flow', url: asset('video') },
      { type: 'image', title: 'Untrusted', url: 'https://evil.test/image.png' },
    ]} />);
    expect(screen.getByRole('heading', { name: 'Visual Previews' })).toBeInTheDocument();
    expect(screen.getByAltText('Settings dialog')).toHaveAttribute('src', asset('image'));
    expect(screen.getByText('Dialog at desktop width')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open full-size preview: Settings dialog' })).toHaveAttribute('href', asset('image'));
    expect(screen.getByRole('link', { name: 'Open original: Checkout flow' })).toHaveAttribute('target', '_blank');
    const video = container.querySelector('video');
    expect(video).toHaveAttribute('src', asset('video'));
    expect(video).toHaveAttribute('controls');
    expect(screen.queryByText('Untrusted')).toBeNull();
  });

  it('renders nothing for runs without published previews', () => {
    expect(render(<TaskVisualPreviews />).container).toBeEmptyDOMElement();
    expect(render(<TaskVisualPreviews previews={[]} />).container).toBeEmptyDOMElement();
  });
});
