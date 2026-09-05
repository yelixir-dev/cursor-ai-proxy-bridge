import { describe, expect, it } from 'vitest';
import { compareClientProfiles } from '../scripts/native-profile-compare.mjs';

function profile(suffix = '1') {
  const conversation = '00000000-0000-4000-8000-00000000000' + suffix;
  return {
    run: {
      runId: '10000000-0000-4000-8000-00000000000' + suffix,
      conversationId: conversation,
      conversationGroupId: conversation,
      requestedModel: { modelId: 'composer-2.5', parameters: [{ id: 'fast', value: 'false' }] },
      action: {
        action: {
          case: 'userMessageAction',
          value: {
            userMessage: {
              messageId: '20000000-0000-4000-8000-00000000000' + suffix,
              text: 'fixed user payload',
              mode: 1,
            },
          },
        },
      },
    },
    context: {
      env: {
        projectFolder: '/profile/project',
        agentConversationNotesFolder: '/profile/project/agent-notes/' + conversation,
      },
      repositoryInfo: [
        { repoName: 'repository', repoOwner: 'owner', pathEncryptionKey: 'stable-account-key' },
      ],
      agentSkills: [{ fullPath: '/profile/skill/SKILL.md', description: 'SKILL_DESCRIPTION' }],
      hooksConfig: {},
    },
  };
}

describe('complete native client profile comparison', () => {
  it('normalizes repository IDs only for explicitly fresh profiles', () => {
    const a = profile();
    const b = profile('2');
    a.context.repositoryInfo[0].repoName = '40000000-0000-4000-8000-000000000001';
    b.context.repositoryInfo[0].repoName = '40000000-0000-4000-8000-000000000002';
    expect(compareClientProfiles(a, b, { freshRepositories: true }).ok).toBe(true);
  });
  it('still compares account encryption keys in a fresh profile', () => {
    const a = profile();
    const b = profile('2');
    b.context.repositoryInfo[0].pathEncryptionKey = 'wrong-account-key';
    expect(compareClientProfiles(a, b, { freshRepositories: true }).ok).toBe(false);
  });

  it('normalizes only generated Run identities and their notes-path references', () => {
    expect(compareClientProfiles(profile('1'), profile('2'))).toEqual({
      ok: true,
      differences: [],
    });
  });
  it.each([
    [
      'model parameter',
      (p) => {
        p.run.requestedModel.parameters[0].value = 'true';
      },
    ],
    [
      'skill omission',
      (p) => {
        delete p.context.agentSkills;
      },
    ],
    [
      'skill data',
      (p) => {
        p.context.agentSkills[0].description = 'OTHER_DESCRIPTION';
      },
    ],
    [
      'repository key',
      (p) => {
        p.context.repositoryInfo[0].pathEncryptionKey = 'different-key';
      },
    ],
    [
      'optional presence',
      (p) => {
        delete p.context.hooksConfig;
      },
    ],
    [
      'incorrect conversation reference',
      (p) => {
        p.context.env.agentConversationNotesFolder = '/profile/project/agent-notes/wrong';
      },
    ],
    [
      'caller text UUID',
      (p) => {
        p.run.action.action.value.userMessage.text = '30000000-0000-4000-8000-000000000002';
      },
    ],
  ])('rejects a meaningful %s difference without exposing values', (_name, mutate) => {
    const expected = profile();
    expected.run.action.action.value.userMessage.text = '30000000-0000-4000-8000-000000000001';
    const actual = globalThis.structuredClone(expected);
    mutate(actual);
    const result = compareClientProfiles(expected, actual);
    expect(result.ok).toBe(false);
    expect(result.differences.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain('different-key');
  });
  it('does not accept missing Run or context evidence', () => {
    expect(compareClientProfiles({}, {}).ok).toBe(false);
  });
});
