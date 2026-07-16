// Exam-code resolution for the read APIs. Exact (case-insensitive) match first;
// then a fallback that finds historical rows keyed by a long timed slug
// ("operations-and-supply-chain-management-c720") when the caller asks for the
// clean code ("C720"). Keeps the API working across old and new collections.

export function exactCodeWhere(code: string) {
  return { examCode: { equals: code, mode: "insensitive" as const } };
}

export function fuzzyCodeWhere(code: string) {
  return {
    OR: [
      { examCode: { endsWith: `-${code}`, mode: "insensitive" as const } },
      { timedSlug: { endsWith: `-${code.toLowerCase()}` } },
    ],
  };
}
