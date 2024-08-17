export async function defaultIteratorReturn<T>(value?: T) {
  return { value, done: true } as const;
}