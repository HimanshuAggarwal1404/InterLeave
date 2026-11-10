// Exit codes (docs/SPEC.md section 3).
export const EXIT_OK = 0; // no violation found
export const EXIT_FOUND = 1; // a violation (or deadlock) was found
export const EXIT_USAGE = 2; // usage or configuration error
export const EXIT_INTERNAL = 3; // internal error, or a problem that stopped the exploration
