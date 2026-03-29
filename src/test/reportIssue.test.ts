import { describe, it, expect } from 'vitest';

/**
 * Test the URL encoding logic used in reportIssue command.
 * The body must be encoded so that:
 * - & becomes %26 (query param separator)
 * - spaces become %20
 * - newlines become %0A
 * - # stays as # (markdown headers)
 * - ? stays as ? (markdown)
 * - | becomes %7C (markdown tables / shell safety)
 */
function encodeIssueBody(body: string): string {
  return body.replace(/&/g, '%26').replace(/\|/g, '%7C').replace(/\n/g, '%0A').replace(/ /g, '%20');
}

describe('reportIssue URL encoding', () => {
  it.each([
    ['keeps # for markdown headers', '## Heading', '#', '%23'],
    ['keeps ? for markdown', '## What happened?\n', '?', '%3F'],
  ])('%s', (_desc, body, shouldContain, shouldNotContain) => {
    const encoded = encodeIssueBody(body);
    expect(encoded).toContain(shouldContain);
    expect(encoded).not.toContain(shouldNotContain);
  });

  it.each([
    ['| to %7C (shell safety)', 'a | b', '|', '%7C'],
    ['& to %26 (query param)', 'Drag & drop', '&', '%26'],
  ])('encodes %s', (_desc, body, raw, encoded) => {
    const result = encodeIssueBody(body);
    expect(result).not.toContain(raw);
    expect(result).toContain(encoded);
  });

  it.each([
    ['spaces as %20', 'hello world', 'hello%20world'],
    ['newlines as %0A', 'line1\nline2', 'line1%0Aline2'],
  ])('encodes %s', (_desc, body, expected) => {
    expect(encodeIssueBody(body)).toBe(expected);
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

    expect(url).not.toContain('%23');
    expect(url).not.toContain('%3F');
    // Exactly 2 & — one for labels&body, none in body (encoded as %26)
    expect(url.split('&').length).toBe(2);
    expect(encoded).toContain('##%20What%20happened?');
    expect(encoded).toContain('%7C');
    expect(encoded).not.toContain('|');
  });
});
