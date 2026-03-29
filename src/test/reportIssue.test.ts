import { describe, it, expect } from 'vitest';

/**
 * Test the URL encoding logic used in reportIssue command.
 * The body must be encoded so that:
 * - & becomes %26 (query param separator)
 * - spaces become %20
 * - newlines become %0A
 * - # stays as # (markdown headers)
 * - ? stays as ? (markdown)
 * - | stays as | (markdown tables)
 */
function encodeIssueBody(body: string): string {
  return body.replace(/&/g, '%26').replace(/\|/g, '%7C').replace(/\n/g, '%0A').replace(/ /g, '%20');
}

describe('reportIssue URL encoding', () => {
  it('should keep # as # for markdown headers', () => {
    const body = '## What happened?\n\nDescription';
    const encoded = encodeIssueBody(body);
    expect(encoded).toContain('##');
    expect(encoded).not.toContain('%23');
  });

  it('should keep ? as ? for markdown', () => {
    const body = '## What happened?\n';
    const encoded = encodeIssueBody(body);
    expect(encoded).toContain('?');
    expect(encoded).not.toContain('%3F');
  });

  it('should encode | to %7C (breaks shell pipe on Windows)', () => {
    const body = '| Parameter | Value |\n|---|---|\n| OS | win32 |';
    const encoded = encodeIssueBody(body);
    expect(encoded).not.toContain('|');
    expect(encoded).toContain('%7C');
  });

  it('should encode & to prevent query param splitting', () => {
    const body = 'Drag & drop screenshots';
    const encoded = encodeIssueBody(body);
    expect(encoded).not.toContain('&');
    expect(encoded).toContain('%26');
  });

  it('should encode spaces as %20', () => {
    const body = 'hello world';
    const encoded = encodeIssueBody(body);
    expect(encoded).toBe('hello%20world');
  });

  it('should encode newlines as %0A', () => {
    const body = 'line1\nline2';
    const encoded = encodeIssueBody(body);
    expect(encoded).toBe('line1%0Aline2');
  });

  it('should produce a valid URL with full template', () => {
    const body = `## What happened?

<!-- Describe what went wrong -->

## Environment

| Parameter | Value |
|---|---|
| Viewstor | v0.1.0 |
| OS | win32 x64 |
| Connections | postgresql |
`;
    const encoded = encodeIssueBody(body);
    const url = `https://github.com/Siyet/viewstor/issues/new?labels=bug&body=${encoded}`;

    // URL should not double-encode # and ?
    expect(url).not.toContain('%23');
    expect(url).not.toContain('%3F');
    // Should have exactly 2 & — one for labels&body, none in body (encoded as %26)
    expect(url.split('&').length).toBe(2);
    // # stays plain, | encoded for shell safety
    expect(encoded).toContain('##%20What%20happened?');
    expect(encoded).toContain('%7C');
    expect(encoded).not.toContain('|');
  });
});
