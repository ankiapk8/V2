import { createRoot } from "react-dom/client";
import "./index.css";

type PromiseWithResolversConstructor = PromiseConstructor & {
  withResolvers?: <T>() => {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
  };
};

const promiseConstructor = Promise as PromiseWithResolversConstructor;

if (!promiseConstructor.withResolvers) {
  promiseConstructor.withResolvers = function withResolvers<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    return { promise, resolve, reject };
  };
}

const { default: App } = await import("./App");

createRoot(document.getElementById("root")!).render(<App />);
