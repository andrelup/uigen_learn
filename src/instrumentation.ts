// Fix Node.js 25+ Web Storage SSR compatibility.
//
// Node 25 exposes global localStorage/sessionStorage via the experimental
// Web Storage API. Without --localstorage-file these globals exist but are
// non-functional, causing errors during SSR when dependencies detect the
// global and assume a browser environment.
//
// Removing the globals on the server restores pre-25 behaviour where
// typeof localStorage === "undefined" and SSR guard checks work correctly.

export async function register() {
  if (typeof window === "undefined") {
    delete (globalThis as any).localStorage;
    delete (globalThis as any).sessionStorage;
  }
}
