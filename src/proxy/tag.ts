export const MAX_TAG_LEN = 64;

// TagError means a query starts with our tag comment, but the comment is
// broken (an app bug). The proxy logs it and treats the query as untagged.
export class TagError extends Error {
  override name = 'TagError';
}

// requestTag returns the request tag of a query that starts with the comment
// /* il:req=<tag> */ (leading whitespace allowed). Only the start of the query
// counts (D-015): the same text inside a string value must not pose as a tag.
// It returns "" for an untagged query, and throws TagError when the query
// starts with our comment but the comment is broken.
export function requestTag(sql: string): string {
  let rest = sql.replace(/^[ \t\r\n]+/, '');
  if (!rest.startsWith('/*')) {
    return '';
  }
  rest = rest.slice(2).replace(/^ +/, '');
  if (!rest.startsWith('il:req=')) {
    return ''; // some other comment
  }
  rest = rest.slice('il:req='.length);
  const end = rest.indexOf('*/');
  if (end < 0) {
    throw new TagError(`request tag comment is not closed: ${quoteTruncated(sql, 60)}`);
  }
  const tag = rest.slice(0, end).replace(/ +$/, '');
  if (!validTag(tag)) {
    throw new TagError(`invalid request tag ${quoteTruncated(tag, 70)}: want 1-${MAX_TAG_LEN} of A-Z a-z 0-9 _ -`);
  }
  return tag;
}

// validTag accepts 1-64 characters of A-Z a-z 0-9 _ -.
export function validTag(tag: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(tag);
}

// quoteTruncated quotes s, cut to max characters, so a huge query cannot flood the log.
function quoteTruncated(s: string, max: number): string {
  return JSON.stringify(s.slice(0, max));
}
