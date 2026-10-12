/**
 * EvaluationEventOverlay shows one card per evaluation name with the mean score.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { EvaluationEventOverlay } from '../components/EvaluationEventOverlay.js';
import { makeEvaluation } from './support/fixtures.js';

afterEach(cleanup);

describe('EvaluationEventOverlay', () => {
  it('averages the scored evaluations and leaves unscored ones out of the mean', () => {
    const { container } = render(<EvaluationEventOverlay evaluations={[
      makeEvaluation({ evaluationName: 'relevance', scoreValue: 0.6 }),
      makeEvaluation({ evaluationName: 'relevance', scoreValue: 0.8 }),
      makeEvaluation({ evaluationName: 'relevance', scoreValue: undefined }),
    ]} />);

    expect(screen.getByLabelText(/^Score: 0\.7,/)).toBeDefined();
    expect(container.textContent).toContain('0.70');
    expect(container.textContent).toContain('(3)');
  });

  it('shows no data when no evaluation in a group carries a score', () => {
    render(<EvaluationEventOverlay evaluations={[makeEvaluation({ evaluationName: 'coherence', scoreValue: undefined })]} />);

    expect(screen.getByLabelText('coherence: no data')).toBeDefined();
  });
});
