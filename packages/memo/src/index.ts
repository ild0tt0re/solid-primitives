import {
  Accessor,
  createSignal,
  createComputed,
  untrack,
  getOwner,
  onCleanup,
  createMemo,
  runWithOwner,
  Setter,
  on,
  getListener,
  createRoot
} from "solid-js";
import type {
  EffectOptions,
  MemoOptions,
  Owner,
  SignalOptions
} from "solid-js/types/reactive/signal";
import { debounce, throttle } from "@solid-primitives/scheduled";
import { ItemsOf, noop } from "@solid-primitives/utils";

export type MemoOptionsWithValue<T> = MemoOptions<T> & { value?: T };
export type AsyncMemoCalculation<T, Init = undefined> = (prev: T | Init) => Promise<T> | T;

const set =
  <T>(setter: Setter<T>) =>
  (v: T): void => {
    setter(() => v);
  };

const callbackWith = <A, T>(fn: (a: A) => T, v: Accessor<A>): (() => T) =>
  fn.length > 0 ? () => fn(untrack(v)) : (fn as () => T);

/**
 * Solid's `createReaction` that is based on pure computation *(runs before render, and is non-batching)*
 *
 * @param onInvalidate callback that runs when the tracked sources trigger update
 * @param options set computation name for debugging pourposes
 * - `options.initial` — an array of functions to be run initially and tracked. *(useful for runing code before other pure computations)*
 * @returns track() function
 *
 * @see https://github.com/solidjs-community/solid-primitives/tree/main/packages/memo#createPureReaction
 *
 * @example
 * const [count, setCount] = createSignal(0);
 * const track = createPureReaction(() => {...});
 * track(count);
 * setCount(1); // triggers callback
 *
 * // sources need to be re-tracked every time
 * setCount(2); // doesn't trigger callback
 */
export function createPureReaction(
  onInvalidate: VoidFunction,
  options?: EffectOptions
): (tracking: VoidFunction) => void {
  const owner = getOwner()!;
  const disposers: VoidFunction[] = [];
  onCleanup(() => {
    for (const fn of disposers) fn();
    disposers.length = 0;
  });
  let trackers = 0;

  // track()
  return tracking => {
    trackers++;
    createRoot(dispose => {
      disposers.push(dispose);
      let init = true;
      createComputed(() => {
        if (init) {
          init = false;
          return tracking();
        }
        if (--trackers === 0) untrack(onInvalidate);
        dispose();
      }, options);
    }, owner);
  };
}

/**
 * A combined memo of multiple sources, last updated source will be the value of the returned signal.
 * @param sources list of reactive calculations/signals/memos
 * @param value specify initial value of the returned signal
 * @param options signal options
 * @returns signal with value of the last updated source
 * @example
 * const [count, setCount] = createSignal(1);
 * const number = createMemo(() => otherValue() * 2);
 * const lastUpdated = createCurtain([count, number]);
 * lastUpdated() // => undefined
 * setCount(4)
 * lastUpdated() // => 4
 */
export function createCurtain<T extends Accessor<any>[]>(
  sources: T,
  value: ReturnType<ItemsOf<T>>,
  options: SignalOptions<ReturnType<ItemsOf<T>>>
): Accessor<ReturnType<ItemsOf<T>>>;
export function createCurtain<T extends Accessor<any>[]>(
  sources: T,
  value?: ReturnType<ItemsOf<T>>,
  options?: SignalOptions<ReturnType<ItemsOf<T>> | undefined>
): Accessor<ReturnType<ItemsOf<T>> | undefined>;
export function createCurtain(
  sources: Accessor<any>[],
  value: any,
  options: SignalOptions<any> = {}
): Accessor<any> {
  const [last, setLast] = createSignal(value, options);
  for (const fn of sources) createComputed(on(fn, set(setLast), { defer: true }));
  return last;
}

/**
 * Solid's `createMemo` which value can be overwritten by a setter. Signal value will be the last one, set by a setter or a memo calculation.
 * @param fn callback that calculates the value
 * @param value initial value (for calcultion)
 * @param options give a name to the reactive computation, or change `equals` method.
 * @returns signal returning value of the last change.
 * @see https://github.com/solidjs-community/solid-primitives/tree/main/packages/memo#createWritableMemo
 * @example
 * const [count, setCount] = createSignal(1);
 * const [result, setResult] = createWritableMemo(() => count() * 2);
 * setResult(5) // overwrites calculation result
 */
export function createWritableMemo<T>(
  fn: (prev: T) => T,
  value: T,
  options?: MemoOptions<T>
): [signal: Accessor<T>, setter: Setter<T>];
export function createWritableMemo<T>(
  fn: (prev: T | undefined) => T,
  value?: undefined,
  options?: MemoOptions<T | undefined>
): [signal: Accessor<T>, setter: Setter<T>];
export function createWritableMemo<T>(
  fn: (prev: T | undefined) => T,
  value?: T,
  options?: MemoOptions<T | undefined>
): [signal: Accessor<T>, setter: Setter<T>] {
  const [signal, setSignal] = createSignal(fn(value), options);
  const calc = callbackWith(fn, signal);
  createComputed(on(calc, set(setSignal), { defer: true }));
  return [signal, setSignal];
}

/**
 * Solid's `createMemo` which returned signal is debounced.
 *
 * @param calc reactive calculation returning signals value
 * @param timeoutMs The duration to debounce in ms
 * @param options specify initial value *(by default it will be undefined)*
 *
 * @see https://github.com/solidjs-community/solid-primitives/tree/main/packages/memo#createDebouncedMemo
 *
 * @example
 * const double = createDebouncedMemo(() => count() * 2, 200)
 */
export function createDebouncedMemo<T>(
  calc: (prev: T) => T,
  timeoutMs: number,
  options: MemoOptionsWithValue<T> & { value: T }
): Accessor<T>;
export function createDebouncedMemo<T>(
  calc: (prev: T | undefined) => T,
  timeoutMs: number,
  options?: MemoOptionsWithValue<T>
): Accessor<T>;
export function createDebouncedMemo<T>(
  calc: (prev: T | undefined) => T,
  timeoutMs: number,
  options: MemoOptionsWithValue<T | undefined> = {}
): Accessor<T> {
  let onInvalidate: VoidFunction = noop;
  const track = createPureReaction(() => onInvalidate());
  const [state, setState] = createSignal(
    (() => {
      let v!: T;
      track(() => (v = calc(options.value)));
      return v;
    })(),
    options
  );
  const fn = debounce(() => track(() => setState(calc)), timeoutMs);
  onInvalidate = () => {
    fn();
    track(() => calc(state()));
  };
  return state;
}

/**
 * Solid's `createMemo` which returned signal is throttled.
 *
 * @param calc reactive calculation returning signals value
 * @param timeoutMs The duration to throttle in ms
 * @param options specify initial value *(by default it will be undefined)*
 *
 * @see https://github.com/solidjs-community/solid-primitives/tree/main/packages/memo#createThrottledMemo
 *
 * @example
 * const double = createThrottledMemo(() => count() * 2, 200)
 */
export function createThrottledMemo<T>(
  calc: (prev: T) => T,
  timeoutMs: number,
  options: MemoOptionsWithValue<T> & { value: T }
): Accessor<T>;
export function createThrottledMemo<T>(
  calc: (prev: T | undefined) => T,
  timeoutMs: number,
  options?: MemoOptionsWithValue<T>
): Accessor<T>;
export function createThrottledMemo<T>(
  calc: (prev: T | undefined) => T,
  timeoutMs: number,
  options: MemoOptionsWithValue<T | undefined> = {}
): Accessor<T> {
  let onInvalidate: VoidFunction = noop;
  const track = createPureReaction(() => onInvalidate());
  const [state, setState] = createSignal(
    (() => {
      let v!: T;
      track(() => (v = calc(options.value)));
      return v;
    })(),
    options
  );
  onInvalidate = throttle(() => track(() => setState(calc)), timeoutMs);
  return state;
}

/**
 * Solid's `createMemo` that allows for asynchronous calculations.
 *
 * @param calc reactive calculation returning a promise
 * @param options specify initial value *(by default it will be undefined)*
 * @returns signal of values resolved from running calculations
 *
 * **calculation will track reactive reads synchronously — untracks after first `await`**
 *
 * @see https://github.com/solidjs-community/solid-primitives/tree/main/packages/memo#createAsyncMemo
 *
 * @example
 * const memo = createAsyncMemo(async prev => {
 *    const value = await myAsyncFunc(signal())
 *    return value.data
 * }, { value: 'initial value' })
 */
export function createAsyncMemo<T>(
  calc: AsyncMemoCalculation<T, T>,
  options: MemoOptionsWithValue<T> & { value: T }
): Accessor<T>;
export function createAsyncMemo<T>(
  calc: AsyncMemoCalculation<T>,
  options?: MemoOptionsWithValue<T>
): Accessor<T | undefined>;
export function createAsyncMemo<T>(
  calc: AsyncMemoCalculation<T>,
  options: MemoOptionsWithValue<T | undefined> = {}
): Accessor<T | undefined> {
  const [state, setState] = createSignal(options.value, options);
  /** pending promises from oldest to newest */
  const order: Promise<T>[] = [];

  // prettier-ignore
  createComputed(async () => {
    const value = calc(untrack(state));
    if (value instanceof Promise) {
      order.push(value);
      // resolved value will only be written to the signal,
      // if the promise wasn't removed from the array
      value.then(r => order.includes(value) && setState(() => r))
      // when a promise finishes, it removes itself, and every older promise from array,
      // blocking them from overwriting the state if they finish after
      value.finally(() => {
        const index = order.indexOf(value);
        order.splice(0, index + 1);
      });
    }
    else setState(() => value);
  }, undefined, options);

  return state;
}

/**
 * Lazily evaluated `createMemo`. Will run the calculation only if is being listened to.
 *
 * @param calc pure reactive calculation returning some value
 * @param value the initial previous value *(in callback)*
 * @param options set computation name for debugging pourposes
 * @returns signal of a value that was returned by the calculation
 *
 * @see https://github.com/solidjs-community/solid-primitives/tree/main/packages/memo#createLazyMemo
 *
 * @example
 * const double = createLazyMemo(() => count() * 2)
 */

// initial value was provided
export function createLazyMemo<T>(
  calc: (prev: T) => T,
  value: T,
  options?: MemoOptions<T>
): Accessor<T>;
// no initial value was provided
export function createLazyMemo<T>(
  calc: (prev: T | undefined) => T,
  value?: undefined,
  options?: MemoOptions<T>
): Accessor<T>;
export function createLazyMemo<T>(
  calc: (prev: T | undefined) => T,
  value?: T,
  options?: MemoOptions<T>
): Accessor<T> {
  /** original root in which the primitive was initially run */
  const owner = getOwner() ?? undefined;
  /** number of places where the state is being tracked */
  let listeners = 0;
  /** lastly calculated value */
  let lastest: T | undefined = value;
  /** does the value need to be recalculated? — for reading outside of tracking scopes */
  let dirty = true;
  let memo: Accessor<T> | undefined;
  let dispose: VoidFunction | undefined;
  onCleanup(() => dispose?.());

  // marks the lastest value as dirty if the sources updated
  const track = createPureReaction(() => (dirty = !memo));

  return () => {
    // path for access outside of tracking scopes
    if (!getListener()) {
      if (memo) return memo();
      if (dirty) track(() => (lastest = calc(lastest)));
      dirty = false;
      return lastest!;
    }

    listeners++;
    onCleanup(() => listeners--);

    if (!memo) {
      createRoot(_dispose => {
        dispose = _dispose;
        memo = createMemo(
          () => {
            if (listeners) return (lastest = calc(lastest));
            dispose!();
            dispose = memo = undefined;
            return lastest!;
          },
          lastest,
          options
        );
      }, owner);
    }

    return memo!();
  };
}

export type CacheCalculation<Key, Value> = (key: Key, prev: Value | undefined) => Value;
export type CacheKeyAccessor<Key, Value> = (key: Key) => Value;
export type CacheOptions<Value> = MemoOptions<Value> & { size?: number };

/**
 * Custom, lazily-evaluated, cached memo. The caching is based on a `key`, it has to be declared up-front as a reactive source, or passed to the signal access function.
 *
 * @param key a reactive source, that will serve as cache key (later value access for the same key will be taken from cache instead of recalculated)
 * @param calc calculation function returning value to cache. the function is **tracking** - will recalculate when the accessed signals change.
 * @param options set maximum **size** of the cache, or memo options.
 * @returns signal access function
 *
 * @see https://github.com/solidjs-community/solid-primitives/tree/main/packages/memo#createMemoCache
 *
 * @example
 * set the reactive key up-front
 * ```ts
 * const [count, setCount] = createSignal(1)
 * const double = createMemoCache(count, n => n * 2)
 * // access value:
 * double()
 * ```
 * or pass it to the access function (let's accessing different keys in different places)
 * ```ts
 * const double = createMemoCache((n: number) => n * 2)
 * // access with key
 * double(count())
 * ```
 */
export function createMemoCache<Key, Value>(
  key: Accessor<Key>,
  calc: CacheCalculation<Key, Value>,
  options?: CacheOptions<Value>
): Accessor<Value>;
export function createMemoCache<Key, Value>(
  calc: CacheCalculation<Key, Value>,
  options?: CacheOptions<Value>
): CacheKeyAccessor<Key, Value>;
export function createMemoCache<Key, Value>(
  ...args:
    | [key: Accessor<Key>, calc: CacheCalculation<Key, Value>, options?: CacheOptions<Value>]
    | [calc: CacheCalculation<Key, Value>, options?: CacheOptions<Value>]
): CacheKeyAccessor<Key, Value> | Accessor<Value> {
  const cache = new Map<Key, Accessor<Value>>();
  const owner = getOwner() as Owner;

  const key = typeof args[1] === "function" ? (args[0] as Accessor<Key>) : undefined,
    calc = typeof args[1] === "function" ? args[1] : (args[0] as CacheCalculation<Key, Value>),
    options = typeof args[1] === "object" ? args[1] : typeof args[2] === "object" ? args[2] : {};

  const run: CacheKeyAccessor<Key, Value> = key => {
    if (cache.has(key)) return (cache.get(key) as Accessor<Value>)();
    const memo = runWithOwner(owner, () =>
      createLazyMemo<Value>(prev => calc(key, prev), undefined, options)
    );
    if (options.size === undefined || cache.size < options.size) cache.set(key, memo);
    return memo();
  };

  return key ? () => run(key()) : run;
}
