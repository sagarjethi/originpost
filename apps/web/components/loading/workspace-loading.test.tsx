import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WorkspaceLoading } from './workspace-loading';

describe('workspace loading states', () => {
  it('announces connection loading without promising data is ready', () => {
    const html = renderToStaticMarkup(<WorkspaceLoading />);
    expect(html).toContain('Connecting to OriginPost');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="status"');
    expect(html).not.toContain('Try again');
  });
  it('offers recovery for an unavailable server without claiming content is lost', () => {
    const html = renderToStaticMarkup(<WorkspaceLoading unavailable />);
    expect(html).toContain('Cannot reach your workspace');
    expect(html).toContain('Your saved content has not been changed');
    expect(html).toContain('Try again');
    expect(html).toContain('aria-busy="false"');
  });
});
