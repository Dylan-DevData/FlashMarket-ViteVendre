export function createStore(initialState) {
  let state = Object.freeze({ ...initialState });
  const listeners = new Set();

  return {
    getState() {
      return state;
    },
    setState(nextState) {
      const patch = typeof nextState === 'function' ? nextState(state) : nextState;
      if (!patch || typeof patch !== 'object') {
        throw new TypeError('Le nouvel état doit être un objet.');
      }
      state = Object.freeze({ ...state, ...patch });
      for (const listener of listeners) listener(state);
      return state;
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('Un écouteur d’état est requis.');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
