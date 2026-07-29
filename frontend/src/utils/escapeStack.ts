/**
 * One Escape listener for the whole app. Only the top-most registered handler
 * fires, so closing a submenu can't also clear the selection underneath it.
 */
type Handler = () => void;

const stack: Handler[] = [];
let bound = false;

function onKeyDown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !stack.length) return;
  e.preventDefault();
  e.stopPropagation();
  stack[stack.length - 1]();
}

export function pushEscapeHandler(handler: Handler): () => void {
  if (!bound) {
    document.addEventListener('keydown', onKeyDown, true);
    bound = true;
  }
  stack.push(handler);
  return () => {
    const i = stack.lastIndexOf(handler);
    if (i >= 0) stack.splice(i, 1);
  };
}
