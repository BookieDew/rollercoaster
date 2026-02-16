import { ticketSchema } from '../../src/validation/schemas';

describe('validation schemas', () => {
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
