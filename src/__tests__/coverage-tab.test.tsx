/**
 * Test stubs documenting intended Coverage tab behavior.
 * Blocked by: data compression for coverage heatmap payloads (see BACKLOG.md).
 */
import { describe, it } from 'vitest';

describe('Coverage tab', () => {
  it.todo('Coverage tab is visible in navigation when enabled');
  it.todo('navigating to /coverage renders CoveragePage');
  it.todo('keyboard shortcut g v navigates to /coverage');
  it.todo('CoveragePage renders heatmap with compressed payload');
  it.todo('CoveragePage shows empty state when no coverage data');
  it.todo('CoveragePage renders "Evaluation Coverage" heading');
  it.todo('CoveragePage "Group by" select defaults to By Trace (traceId)');
  it.todo('CoveragePage "Group by" select switches grouping to By Session (sessionId)');
  it.todo('CoveragePage shows loading skeleton while data is fetching');
  it.todo('CoveragePage shows error state when API returns an error');
  it.todo('CoverageGrid renders overall coverage percentage');
  it.todo('CoverageGrid renders gap cells for missing metric/input combinations');
});
