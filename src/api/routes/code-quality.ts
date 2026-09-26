import { Hono } from 'hono';
import { loadTracesByFilter } from '../data-loader.js';
import { sanitizeErrorForResponse } from '../parent/error-sanitizer.js';
import { HttpStatus, TIME_MS } from '../../lib/constants.js';
import { attrStr, attrNum, timestampToMs } from '../api-constants.js';

const LOOKBACK_DAYS = 90;
const LIMIT_CHECKPOINT_SPANS = 5000;
const LIMIT_INVOCATION_SPANS = 1000;
const KEY_SEP = '\x00';

export interface AgentWindowStats {
  agentName: string;
  agentVersion: string;
  window: string;
  avgSurvivalRate: number;
  avgChurnRate: number;
  avgDeletionRate: number;
  checkpointCount: number;
  latestTimestamp: string;
}

export interface AgentVersionStats {
  agentName: string;
  agentVersion: string;
  invocationCount: number;
  latestTimestamp: string;
}

export interface CodeQualityResponse {
  survivalByAgentWindow: AgentWindowStats[];
  versionRollout: AgentVersionStats[];
  hasData: boolean;
}

type WindowAcc = {
  survivalRates: number[];
  churnRates: number[];
  deletionRates: number[];
  latestMs: number;
};

type VersionAcc = {
  invocationCount: number;
  latestMs: number;
};

export const codeQualityRoutes = new Hono();

codeQualityRoutes.get('/code-quality', async (c) => {
  const now = new Date();
  const windowStart = new Date(now.getTime() - LOOKBACK_DAYS * TIME_MS.DAY);
  const startIso = windowStart.toISOString();
  const endIso = now.toISOString();

  try {
    const [checkpointSpans, invocationSpans] = await Promise.all([
      loadTracesByFilter(
        { 'integritystudio.code.event': 'survival_checkpoint' },
        startIso,
        endIso,
        LIMIT_CHECKPOINT_SPANS,
      ),
      loadTracesByFilter(
        { 'integritystudio.code.event': 'generated' },
        startIso,
        endIso,
        LIMIT_INVOCATION_SPANS,
      ),
    ]);

    // Aggregate checkpoint spans by (agentName, agentVersion, window)
    const windowAcc = new Map<string, WindowAcc>();

    for (const span of checkpointSpans) {
      const agentName = attrStr(span, 'gen_ai.agent.name');
      const agentVersion = attrStr(span, 'gen_ai.agent.version');
      const checkpointWindow = attrStr(span, 'integritystudio.code.checkpoint_window');

      if (agentName === 'unknown' || checkpointWindow === 'unknown') continue;

      const key = [agentName, agentVersion, checkpointWindow].join(KEY_SEP);
      let entry = windowAcc.get(key);
      if (!entry) {
        entry = { survivalRates: [], churnRates: [], deletionRates: [], latestMs: 0 };
        windowAcc.set(key, entry);
      }

      entry.survivalRates.push(attrNum(span, 'integritystudio.code.quality.survival_rate'));
      entry.churnRates.push(attrNum(span, 'integritystudio.code.quality.churn_rate'));
      entry.deletionRates.push(attrNum(span, 'integritystudio.code.quality.deletion_rate'));

      const spanMs = timestampToMs(span.startTimeUnixNano);
      if (Number.isFinite(spanMs) && spanMs > entry.latestMs) {
        entry.latestMs = spanMs;
      }
    }

    function avg(nums: number[]): number {
      if (nums.length === 0) return 0;
      return nums.reduce((s, n) => s + n, 0) / nums.length;
    }

    const survivalByAgentWindow: AgentWindowStats[] = [];
    for (const [key, entry] of windowAcc) {
      const [agentName = 'unknown', agentVersion = 'unknown', window = 'unknown'] = key.split(KEY_SEP);
      survivalByAgentWindow.push({
        agentName,
        agentVersion,
        window,
        avgSurvivalRate: avg(entry.survivalRates),
        avgChurnRate: avg(entry.churnRates),
        avgDeletionRate: avg(entry.deletionRates),
        checkpointCount: entry.survivalRates.length,
        latestTimestamp: entry.latestMs > 0 ? new Date(entry.latestMs).toISOString() : '',
      });
    }

    // Aggregate invocation spans by (agentName, agentVersion)
    const versionAcc = new Map<string, VersionAcc>();

    for (const span of invocationSpans) {
      const agentName = attrStr(span, 'gen_ai.agent.name');
      const agentVersion = attrStr(span, 'gen_ai.agent.version');
      const key = [agentName, agentVersion].join(KEY_SEP);

      let entry = versionAcc.get(key);
      if (!entry) {
        entry = { invocationCount: 0, latestMs: 0 };
        versionAcc.set(key, entry);
      }

      entry.invocationCount++;
      const spanMs = timestampToMs(span.startTimeUnixNano);
      if (Number.isFinite(spanMs) && spanMs > entry.latestMs) {
        entry.latestMs = spanMs;
      }
    }

    const versionRollout: AgentVersionStats[] = [];
    for (const [key, entry] of versionAcc) {
      const [agentName = 'unknown', agentVersion = 'unknown'] = key.split(KEY_SEP);
      versionRollout.push({
        agentName,
        agentVersion,
        invocationCount: entry.invocationCount,
        latestTimestamp: entry.latestMs > 0 ? new Date(entry.latestMs).toISOString() : '',
      });
    }

    versionRollout.sort((a, b) => b.invocationCount - a.invocationCount);

    const response: CodeQualityResponse = {
      survivalByAgentWindow,
      versionRollout,
      hasData: survivalByAgentWindow.length > 0,
    };

    return c.json(response);
  } catch (err) {
    return c.json({ error: sanitizeErrorForResponse(err) }, HttpStatus.InternalServerError);
  }
});
