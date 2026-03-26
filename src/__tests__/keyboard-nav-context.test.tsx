import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { KeyboardNavProvider, useShortcut, useKeyboardNav } from '../contexts/KeyboardNavContext.js';

afterEach(cleanup);


function ShortcutConsumer({ shortcutKey, desc, scope, action }: {
  shortcutKey: string;
  desc: string;
  scope?: string;
  action?: () => void;
}) {
  useShortcut(shortcutKey, desc, scope ?? 'test', action ?? (() => {}));
  return <div data-testid="consumer">{shortcutKey}</div>;
}

function OverlayReader() {
  const { overlayOpen } = useKeyboardNav();
  return <div data-testid="overlay">{overlayOpen ? 'open' : 'closed'}</div>;
}


describe('shortcut conflict guard', () => {
  it('throws when registering single key "g" when combo "g h" already exists', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => {
      render(
        <KeyboardNavProvider>
          <ShortcutConsumer shortcutKey="g h" desc="Go home" />
          <ShortcutConsumer shortcutKey="g" desc="Conflicting single g" />
        </KeyboardNavProvider>,
      );
    }).toThrow(/conflict/i);
    spy.mockRestore();
  });

  it('throws when registering combo "g h" when single key "g" already exists', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => {
      render(
        <KeyboardNavProvider>
          <ShortcutConsumer shortcutKey="g" desc="Go somewhere" />
          <ShortcutConsumer shortcutKey="g h" desc="Conflicting combo g h" />
        </KeyboardNavProvider>,
      );
    }).toThrow(/conflict/i);
    spy.mockRestore();
  });

  it('error message names the conflicting shortcut description', () => {
    // The conflict error should include the description of the conflicting entry
    // so developers can identify what they need to fix
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let caught: Error | null = null;
    try {
      render(
        <KeyboardNavProvider>
          <ShortcutConsumer shortcutKey="g h" desc="Go home page" />
          <ShortcutConsumer shortcutKey="g" desc="Global search" />
        </KeyboardNavProvider>,
      );
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    // The error message must name the conflicting shortcut so devs know what clashes
    expect(caught!.message).toMatch(/Go home page/);
    spy.mockRestore();
  });

  it('does NOT throw when two combos share no prefix relationship', () => {
    expect(() => {
      render(
        <KeyboardNavProvider>
          <ShortcutConsumer shortcutKey="g h" desc="Go home" />
          <ShortcutConsumer shortcutKey="g j" desc="Go jobs" />
        </KeyboardNavProvider>,
      );
    }).not.toThrow();
  });
});


describe('two-key combo dispatch', () => {
  it('fires combo action when both keys pressed in sequence', () => {
    const action = vi.fn();
    function ComboConsumer() {
      useShortcut('g h', 'Go home', 'nav', action);
      return null;
    }
    render(
      <KeyboardNavProvider>
        <ComboConsumer />
      </KeyboardNavProvider>,
    );
    act(() => { fireEvent.keyDown(document, { key: 'g' }); });
    expect(action).not.toHaveBeenCalled();
    act(() => { fireEvent.keyDown(document, { key: 'h' }); });
    expect(action).toHaveBeenCalledOnce();
  });

  it('fires correct action when two combos share the same prefix', () => {
    const goHome = vi.fn();
    const goJobs = vi.fn();
    function MultiComboConsumer() {
      useShortcut('g h', 'Go home', 'nav', goHome);
      useShortcut('g j', 'Go jobs', 'nav', goJobs);
      return null;
    }
    render(
      <KeyboardNavProvider>
        <MultiComboConsumer />
      </KeyboardNavProvider>,
    );
    act(() => { fireEvent.keyDown(document, { key: 'g' }); });
    act(() => { fireEvent.keyDown(document, { key: 'j' }); });
    expect(goJobs).toHaveBeenCalledOnce();
    expect(goHome).not.toHaveBeenCalled();
  });

  it('does NOT fire combo when only the first key is pressed', () => {
    const action = vi.fn();
    function ComboConsumer() {
      useShortcut('g h', 'Go home', 'nav', action);
      return null;
    }
    render(
      <KeyboardNavProvider>
        <ComboConsumer />
      </KeyboardNavProvider>,
    );
    act(() => { fireEvent.keyDown(document, { key: 'g' }); });
    expect(action).not.toHaveBeenCalled();
  });

  it('does NOT fire combo when second key does not match', () => {
    const action = vi.fn();
    function ComboConsumer() {
      useShortcut('g h', 'Go home', 'nav', action);
      return null;
    }
    render(
      <KeyboardNavProvider>
        <ComboConsumer />
      </KeyboardNavProvider>,
    );
    act(() => {
      fireEvent.keyDown(document, { key: 'g' });
      fireEvent.keyDown(document, { key: 'x' });
    });
    expect(action).not.toHaveBeenCalled();
  });

  it('re-arms combo pending after a failed second key', () => {
    // After "g" + "x" fails, a fresh "g" + "h" should fire the combo
    const action = vi.fn();
    function ComboConsumer() {
      useShortcut('g h', 'Go home', 'nav', action);
      return null;
    }
    render(
      <KeyboardNavProvider>
        <ComboConsumer />
      </KeyboardNavProvider>,
    );
    act(() => {
      fireEvent.keyDown(document, { key: 'g' });
      fireEvent.keyDown(document, { key: 'x' }); // fails, clears pending
    });
    act(() => {
      fireEvent.keyDown(document, { key: 'g' }); // re-arms
      fireEvent.keyDown(document, { key: 'h' }); // should fire
    });
    expect(action).toHaveBeenCalledOnce();
  });

  it('combo should NOT fire when first key arrives from an ignored INPUT element', () => {
    // The IGNORED_TAGS guard must also block combo priming from inputs
    const action = vi.fn();
    function ComboConsumer() {
      useShortcut('g h', 'Go home', 'nav', action);
      return <input data-testid="input-field" />;
    }
    render(
      <KeyboardNavProvider>
        <ComboConsumer />
      </KeyboardNavProvider>,
    );
    const input = screen.getByTestId('input-field');
    // Press "g" from input — should NOT prime the combo
    act(() => { fireEvent.keyDown(input, { key: 'g' }); });
    // Press "h" on document — if "g" was NOT primed, this won't fire the combo
    act(() => { fireEvent.keyDown(document, { key: 'h' }); });
    expect(action).not.toHaveBeenCalled();
  });
});


describe('combo timeout', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('clears pending after 500ms so a late second key does not fire the combo', () => {
    const action = vi.fn();
    function ComboConsumer() {
      useShortcut('g h', 'Go home', 'nav', action);
      return null;
    }
    render(
      <KeyboardNavProvider>
        <ComboConsumer />
      </KeyboardNavProvider>,
    );
    act(() => { fireEvent.keyDown(document, { key: 'g' }); });
    act(() => { vi.advanceTimersByTime(501); });
    act(() => { fireEvent.keyDown(document, { key: 'h' }); });
    expect(action).not.toHaveBeenCalled();
  });

  it('fires combo when second key arrives before the 500ms timeout', () => {
    const action = vi.fn();
    function ComboConsumer() {
      useShortcut('g h', 'Go home', 'nav', action);
      return null;
    }
    render(
      <KeyboardNavProvider>
        <ComboConsumer />
      </KeyboardNavProvider>,
    );
    act(() => { fireEvent.keyDown(document, { key: 'g' }); });
    act(() => { vi.advanceTimersByTime(400); });
    act(() => { fireEvent.keyDown(document, { key: 'h' }); });
    expect(action).toHaveBeenCalledOnce();
  });

  it('does NOT fire combo at exactly the 500ms boundary — second key at 500ms is too late', () => {
    // The timeout clears pending at 500ms; a key arriving at that exact moment
    // should NOT fire the combo because the timer has already fired
    const action = vi.fn();
    function ComboConsumer() {
      useShortcut('g h', 'Go home', 'nav', action);
      return null;
    }
    render(
      <KeyboardNavProvider>
        <ComboConsumer />
      </KeyboardNavProvider>,
    );
    act(() => { fireEvent.keyDown(document, { key: 'g' }); });
    // Advance exactly to the timeout boundary
    act(() => { vi.advanceTimersByTime(500); });
    act(() => { fireEvent.keyDown(document, { key: 'h' }); });
    // Pending was cleared by the timer at 500ms; action must not fire
    expect(action).not.toHaveBeenCalled();
  });
});


describe('overlay toggle', () => {
  it('starts closed', () => {
    render(
      <KeyboardNavProvider>
        <OverlayReader />
      </KeyboardNavProvider>,
    );
    expect(screen.getByTestId('overlay').textContent).toBe('closed');
  });

  it('pressing ? opens the overlay', () => {
    render(
      <KeyboardNavProvider>
        <OverlayReader />
      </KeyboardNavProvider>,
    );
    act(() => { fireEvent.keyDown(document, { key: '?' }); });
    expect(screen.getByTestId('overlay').textContent).toBe('open');
  });

  it('pressing ? a second time closes the overlay', () => {
    render(
      <KeyboardNavProvider>
        <OverlayReader />
      </KeyboardNavProvider>,
    );
    act(() => { fireEvent.keyDown(document, { key: '?' }); });
    act(() => { fireEvent.keyDown(document, { key: '?' }); });
    expect(screen.getByTestId('overlay').textContent).toBe('closed');
  });

  it('pressing Escape closes an open overlay', () => {
    render(
      <KeyboardNavProvider>
        <OverlayReader />
      </KeyboardNavProvider>,
    );
    act(() => { fireEvent.keyDown(document, { key: '?' }); });
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }); });
    expect(screen.getByTestId('overlay').textContent).toBe('closed');
  });

  it('pressing Escape when overlay is closed has no effect', () => {
    render(
      <KeyboardNavProvider>
        <OverlayReader />
      </KeyboardNavProvider>,
    );
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }); });
    expect(screen.getByTestId('overlay').textContent).toBe('closed');
  });

  it('Escape with Ctrl held does NOT close the overlay', () => {
    // Modifier keys bypass all shortcut handling including overlay escape
    render(
      <KeyboardNavProvider>
        <OverlayReader />
      </KeyboardNavProvider>,
    );
    act(() => { fireEvent.keyDown(document, { key: '?' }); });
    expect(screen.getByTestId('overlay').textContent).toBe('open');
    act(() => { fireEvent.keyDown(document, { key: 'Escape', ctrlKey: true }); });
    // Overlay should still be open because Ctrl modifier bypasses handler
    expect(screen.getByTestId('overlay').textContent).toBe('open');
  });

  it('? with Ctrl held does NOT toggle overlay', () => {
    render(
      <KeyboardNavProvider>
        <OverlayReader />
      </KeyboardNavProvider>,
    );
    act(() => { fireEvent.keyDown(document, { key: '?', ctrlKey: true }); });
    // Modifier bypass prevents overlay from opening
    expect(screen.getByTestId('overlay').textContent).toBe('closed');
  });

  it('programmatic toggleOverlay opens the overlay and Escape then closes it', () => {
    // Tests that Escape responds to programmatic overlay state, not just keydown-opened state
    function TogglerAndReader() {
      const { overlayOpen, toggleOverlay } = useKeyboardNav();
      return (
        <>
          <button data-testid="btn" onClick={toggleOverlay}>toggle</button>
          <div data-testid="overlay">{overlayOpen ? 'open' : 'closed'}</div>
        </>
      );
    }
    render(
      <KeyboardNavProvider>
        <TogglerAndReader />
      </KeyboardNavProvider>,
    );
    act(() => { screen.getByTestId('btn').click(); });
    expect(screen.getByTestId('overlay').textContent).toBe('open');
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }); });
    expect(screen.getByTestId('overlay').textContent).toBe('closed');
  });
});


describe('ignored tags', () => {
  it('does NOT fire shortcut when keydown originates from INPUT', () => {
    const action = vi.fn();
    function ActionConsumer() {
      useShortcut('k', 'Do something', 'test', action);
      return <input data-testid="input-field" />;
    }
    render(
      <KeyboardNavProvider>
        <ActionConsumer />
      </KeyboardNavProvider>,
    );
    act(() => { fireEvent.keyDown(screen.getByTestId('input-field'), { key: 'k' }); });
    expect(action).not.toHaveBeenCalled();
  });

  it('does NOT fire shortcut when keydown originates from TEXTAREA', () => {
    const action = vi.fn();
    function ActionConsumer() {
      useShortcut('k', 'Do something', 'test', action);
      return <textarea data-testid="textarea-field" />;
    }
    render(
      <KeyboardNavProvider>
        <ActionConsumer />
      </KeyboardNavProvider>,
    );
    act(() => { fireEvent.keyDown(screen.getByTestId('textarea-field'), { key: 'k' }); });
    expect(action).not.toHaveBeenCalled();
  });

  it('does NOT fire shortcut when keydown originates from SELECT', () => {
    const action = vi.fn();
    function ActionConsumer() {
      useShortcut('k', 'Do something', 'test', action);
      return <select data-testid="select-field"><option value="a">A</option></select>;
    }
    render(
      <KeyboardNavProvider>
        <ActionConsumer />
      </KeyboardNavProvider>,
    );
    act(() => { fireEvent.keyDown(screen.getByTestId('select-field'), { key: 'k' }); });
    expect(action).not.toHaveBeenCalled();
  });

  it('DOES fire shortcut when keydown originates from a div', () => {
    const action = vi.fn();
    function ActionConsumer() {
      useShortcut('k', 'Do something', 'test', action);
      return <div data-testid="div-field" tabIndex={0} />;
    }
    render(
      <KeyboardNavProvider>
        <ActionConsumer />
      </KeyboardNavProvider>,
    );
    act(() => { fireEvent.keyDown(screen.getByTestId('div-field'), { key: 'k' }); });
    expect(action).toHaveBeenCalledOnce();
  });

  it('does NOT open overlay via ? when keydown originates from INPUT', () => {
    // The ? overlay toggle must also be suppressed when focus is in an input
    function OverlayAndInput() {
      const { overlayOpen } = useKeyboardNav();
      return (
        <>
          <input data-testid="input-field" />
          <div data-testid="overlay">{overlayOpen ? 'open' : 'closed'}</div>
        </>
      );
    }
    render(
      <KeyboardNavProvider>
        <OverlayAndInput />
      </KeyboardNavProvider>,
    );
    act(() => { fireEvent.keyDown(screen.getByTestId('input-field'), { key: '?' }); });
    expect(screen.getByTestId('overlay').textContent).toBe('closed');
  });
});


describe('modifier key bypass', () => {
  it('does NOT fire shortcut when Ctrl is held', () => {
    const action = vi.fn();
    function ActionConsumer() {
      useShortcut('k', 'Do something', 'test', action);
      return null;
    }
    render(<KeyboardNavProvider><ActionConsumer /></KeyboardNavProvider>);
    act(() => { fireEvent.keyDown(document, { key: 'k', ctrlKey: true }); });
    expect(action).not.toHaveBeenCalled();
  });

  it('does NOT fire shortcut when Meta is held', () => {
    const action = vi.fn();
    function ActionConsumer() {
      useShortcut('k', 'Do something', 'test', action);
      return null;
    }
    render(<KeyboardNavProvider><ActionConsumer /></KeyboardNavProvider>);
    act(() => { fireEvent.keyDown(document, { key: 'k', metaKey: true }); });
    expect(action).not.toHaveBeenCalled();
  });

  it('does NOT fire shortcut when Alt is held', () => {
    const action = vi.fn();
    function ActionConsumer() {
      useShortcut('k', 'Do something', 'test', action);
      return null;
    }
    render(<KeyboardNavProvider><ActionConsumer /></KeyboardNavProvider>);
    act(() => { fireEvent.keyDown(document, { key: 'k', altKey: true }); });
    expect(action).not.toHaveBeenCalled();
  });

  it('DOES fire shortcut when no modifier keys are held', () => {
    const action = vi.fn();
    function ActionConsumer() {
      useShortcut('k', 'Do something', 'test', action);
      return null;
    }
    render(<KeyboardNavProvider><ActionConsumer /></KeyboardNavProvider>);
    act(() => { fireEvent.keyDown(document, { key: 'k' }); });
    expect(action).toHaveBeenCalledOnce();
  });

  it('does NOT prime combo pending when first key pressed with Ctrl held', () => {
    // Modifier bypass should also prevent combo priming
    const action = vi.fn();
    function ComboConsumer() {
      useShortcut('g h', 'Go home', 'nav', action);
      return null;
    }
    render(<KeyboardNavProvider><ComboConsumer /></KeyboardNavProvider>);
    // "g" with Ctrl should NOT set pendingRef
    act(() => { fireEvent.keyDown(document, { key: 'g', ctrlKey: true }); });
    // "h" without modifier — if pending was wrongly set, this would fire the combo
    act(() => { fireEvent.keyDown(document, { key: 'h' }); });
    expect(action).not.toHaveBeenCalled();
  });
});


describe('duplicate key registration guard', () => {
  it('throws when the same single key is registered twice', () => {
    // Registering "k" twice should be treated as a conflict — two handlers
    // for the same key would cause unpredictable double-fire behavior
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => {
      render(
        <KeyboardNavProvider>
          <ShortcutConsumer shortcutKey="k" desc="First k handler" />
          <ShortcutConsumer shortcutKey="k" desc="Second k handler" />
        </KeyboardNavProvider>,
      );
    }).toThrow(/conflict|duplicate/i);
    spy.mockRestore();
  });

  it('fires the shortcut action exactly once when registered once', () => {
    const action = vi.fn();
    function ActionConsumer() {
      useShortcut('k', 'Test action', 'test', action);
      return null;
    }
    render(
      <KeyboardNavProvider>
        <ActionConsumer />
      </KeyboardNavProvider>,
    );
    act(() => { fireEvent.keyDown(document, { key: 'k' }); });
    expect(action).toHaveBeenCalledTimes(1);
  });
});


describe('unregister', () => {
  it('shortcut no longer fires after the component that registered it unmounts', () => {
    const action = vi.fn();
    function ActionConsumer() {
      useShortcut('z', 'Test action', 'test', action);
      return null;
    }
    const { unmount } = render(
      <KeyboardNavProvider>
        <ActionConsumer />
      </KeyboardNavProvider>,
    );
    act(() => { fireEvent.keyDown(document, { key: 'z' }); });
    expect(action).toHaveBeenCalledOnce();

    unmount();
    render(<KeyboardNavProvider>{null}</KeyboardNavProvider>);

    act(() => { fireEvent.keyDown(document, { key: 'z' }); });
    // After unmount, no further calls
    expect(action).toHaveBeenCalledOnce();
  });

  it('unregistering one shortcut does not affect other registered shortcuts', () => {
    const actionA = vi.fn();
    const actionB = vi.fn();
    function ConsumerA() {
      useShortcut('a', 'Action A', 'test', actionA);
      return null;
    }
    function ConsumerB() {
      useShortcut('b', 'Action B', 'test', actionB);
      return null;
    }
    const { rerender } = render(
      <KeyboardNavProvider>
        <ConsumerA />
        <ConsumerB />
      </KeyboardNavProvider>,
    );

    // Unmount ConsumerA by removing it from the tree
    rerender(
      <KeyboardNavProvider>
        <ConsumerB />
      </KeyboardNavProvider>,
    );

    act(() => { fireEvent.keyDown(document, { key: 'a' }); });
    act(() => { fireEvent.keyDown(document, { key: 'b' }); });

    expect(actionA).not.toHaveBeenCalled();
    expect(actionB).toHaveBeenCalledOnce();
  });

  it('shortcuts array in context reflects the current registered set', () => {
    function ShortcutsCounter() {
      const { shortcuts } = useKeyboardNav();
      return <div data-testid="count">{shortcuts.length}</div>;
    }
    function RegisteredShortcut() {
      useShortcut('m', 'Maybe shortcut', 'test', () => {});
      return null;
    }

    const { rerender } = render(
      <KeyboardNavProvider>
        <ShortcutsCounter />
        <RegisteredShortcut />
      </KeyboardNavProvider>,
    );
    expect(screen.getByTestId('count').textContent).toBe('1');

    // Remove RegisteredShortcut from the tree — its useEffect cleanup should unregister
    rerender(
      <KeyboardNavProvider>
        <ShortcutsCounter />
      </KeyboardNavProvider>,
    );
    // After unregistration, shortcuts array must reflect 0 entries
    expect(screen.getByTestId('count').textContent).toBe('0');
  });
});
