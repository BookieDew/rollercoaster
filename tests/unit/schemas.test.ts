import {
  ticketSchema,
  settlementRequestSchema,
  idParamsSchema,
  userIdParamsSchema,
  betIdParamsSchema,
  lockRequestSchema,
  MAX_IDENTIFIER_LENGTH,
  MAX_SELECTION_ODDS,
  MAX_SELECTIONS,
  MAX_WINNINGS,
} from '../../src/validation/schemas';

describe('validation schemas', () => {
  describe('Phase 0 bounds', () => {
    const atLimit = 'a'.repeat(MAX_IDENTIFIER_LENGTH);
    const overLimit = 'a'.repeat(MAX_IDENTIFIER_LENGTH + 1);

    it('bounds settlement winnings to finite values in [0, MAX_WINNINGS]', () => {
      const base = { bet_id: 'b', outcome: 'WIN' as const };
      expect(settlementRequestSchema.safeParse({ ...base, winnings: 0 }).success).toBe(true);
      expect(settlementRequestSchema.safeParse({ ...base, winnings: MAX_WINNINGS }).success).toBe(true);
      for (const winnings of [Infinity, -Infinity, NaN, 1e300, MAX_WINNINGS + 0.01, -0.01]) {
        expect(settlementRequestSchema.safeParse({ ...base, winnings }).success).toBe(false);
      }
    });

    it('requires UUID ids and 1-255 character user and bet path params', () => {
      expect(idParamsSchema.safeParse({ id: '00000000-0000-4000-8000-000000000000' }).success).toBe(true);
      expect(idParamsSchema.safeParse({ id: 'reward-1' }).success).toBe(false);
      for (const schema of [userIdParamsSchema, betIdParamsSchema]) {
        const key = schema === userIdParamsSchema ? 'userId' : 'betId';
        expect(schema.safeParse({ [key]: atLimit }).success).toBe(true);
        expect(schema.safeParse({ [key]: overLimit }).success).toBe(false);
        expect(schema.safeParse({ [key]: '' }).success).toBe(false);
      }
    });

    it('bounds body identifiers, selection text, odds and selection count', () => {
      expect(lockRequestSchema.safeParse({
        user_id: atLimit, reward_id: '00000000-0000-4000-8000-000000000000', bet_id: atLimit,
      }).success).toBe(true);
      expect(lockRequestSchema.safeParse({
        user_id: overLimit, reward_id: '00000000-0000-4000-8000-000000000000', bet_id: 'b',
      }).success).toBe(false);

      expect(ticketSchema.safeParse({ selections: [{ id: 's', odds: MAX_SELECTION_ODDS }] }).success).toBe(true);
      expect(ticketSchema.safeParse({ selections: [{ id: 's', odds: MAX_SELECTION_ODDS + 0.01 }] }).success).toBe(false);
      for (const field of ['id', 'name', 'market', 'event']) {
        expect(ticketSchema.safeParse({ selections: [{ id: 's', odds: 2, [field]: overLimit }] }).success).toBe(false);
      }
      const selections = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, odds: 1.5 }));
      expect(ticketSchema.safeParse({ selections: selections(MAX_SELECTIONS) }).success).toBe(true);
      expect(ticketSchema.safeParse({ selections: selections(MAX_SELECTIONS + 1) }).success).toBe(false);
    });
  });

  describe('selection SGP metadata', () => {
    it('accepts standard selections without explicit type', () => {
      const result = ticketSchema.parse({
        selections: [{ id: 's1', odds: 1.8 }],
      });

      expect(result.selections).toHaveLength(1);
      expect(result.selections[0].selection_type).toBeUndefined();
    });

    it('accepts SGP composite selections with group id', () => {
      const result = ticketSchema.parse({
        selections: [
          {
            id: 'sgp-1',
            odds: 4.2,
            selection_type: 'SGP_COMPOSITE',
            sgp_group_id: 'group-1',
          },
        ],
      });

      expect(result.selections[0].selection_type).toBe('SGP_COMPOSITE');
      expect(result.selections[0].sgp_group_id).toBe('group-1');
    });

    it('rejects SGP legs without sgp_group_id', () => {
      expect(() => ticketSchema.parse({
        selections: [
          {
            id: 'sgp-leg-1',
            odds: 1.6,
            selection_type: 'SGP_LEG',
          },
        ],
      })).toThrow('sgp_group_id is required when selection_type is SGP_COMPOSITE or SGP_LEG');
    });

    it('rejects standard selections with sgp_group_id', () => {
      expect(() => ticketSchema.parse({
        selections: [
          {
            id: 's1',
            odds: 2.0,
            selection_type: 'STANDARD',
            sgp_group_id: 'group-1',
          },
        ],
      })).toThrow('sgp_group_id is only allowed for SGP_COMPOSITE or SGP_LEG selections');
    });
  });
});
