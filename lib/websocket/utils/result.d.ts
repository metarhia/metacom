export declare class Result<T = unknown, E = Error> {
  private constructor(params: { value?: T; error?: E });

  get value(): T | undefined;
  get error(): Error;

  static from<T, E = Error>(input: T | E): Result<T, E>;
  static empty<T, E = Error>(): Result<T, E>;
}
