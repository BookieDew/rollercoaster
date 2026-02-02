import {
  filterQualifyingSelections,
  meetsMinSelectionCount,
} from '../../src/computations/qualifyingSelectionFilter';
import type { Selection } from '../../src/types/ticket';

describe('qualifyingSelectionFilter', () => {
  describe('filterQualifyingSelections', () => {
    const selections: Selection[] = [
      { id: '1', odds: 1.5, name: 'Selection 1' },
      { id: '2', odds: 2.0, name: 'Selection 2' },
      { id: '3', odds: 1.1, name: 'Selection 3' },
      { id: '4', odds: 3.0, name: 'Selection 4' },
      { id: '5', odds: 1.2, name: 'Selection 5' },
    ];

    it('should filter selections by minimum odds threshold', () => {
      const result = filterQualifyingSelections(selections, 1.2);

      expect(result.qualifying).toHaveLength(4);
      expect(result.disqualified).toHaveLength(1);
      expect(result.disqualified[0].id).toBe('3');
    });

    it('should include selections with odds exactly at threshold', () => {
      const result = filterQualifyingSelections(selections, 1.5);

      expect(result.qualifying).toHaveLength(3);
      expect(result.qualifying.map(s => s.id)).toContain('1');
      expect(result.qualifying.map(s => s.id)).toContain('2');
      expect(result.qualifying.map(s => s.id)).toContain('4');
    });

    it('should return all selections if threshold is very low', () => {
      const result = filterQualifyingSelections(selections, 1.0);

      expect(result.qualifying).toHaveLength(5);
      expect(result.disqualified).toHaveLength(0);
    });

    it('should return no selections if threshold is very high', () => {
      const result = filterQualifyingSelections(selections, 10.0);

      expect(result.qualifying).toHaveLength(0);
      expect(result.disqualified).toHaveLength(5);
    });

    it('should handle empty selections array', () => {
      const result = filterQualifyingSelections([], 1.2);

      expect(result.qualifying).toHaveLength(0);
      expect(result.disqualified).toHaveLength(0);
    });

    it('should handle single selection above threshold', () => {
      const single: Selection[] = [{ id: '1', odds: 2.0 }];
      const result = filterQualifyingSelections(single, 1.5);

      expect(result.qualifying).toHaveLength(1);
      expect(result.disqualified).toHaveLength(0);
    });

    it('should handle single selection below threshold', () => {
      const single: Selection[] = [{ id: '1', odds: 1.1 }];
      const result = filterQualifyingSelections(single, 1.5);

      expect(result.qualifying).toHaveLength(0);
      expect(result.disqualified).toHaveLength(1);
    });
  });

  describe('meetsMinSelectionCount', () => {
    it('should return true when count meets requirement', () => {
      expect(meetsMinSelectionCount(3, 3)).toBe(true);
    });

    it('should return true when count exceeds requirement', () => {
      expect(meetsMinSelectionCount(5, 3)).toBe(true);
    });

    it('should return false when count is below requirement', () => {
      expect(meetsMinSelectionCount(2, 3)).toBe(false);
    });

    it('should return true for zero requirement', () => {
      expect(meetsMinSelectionCount(0, 0)).toBe(true);
    });

    it('should return false when count is zero but requirement is positive', () => {
      expect(meetsMinSelectionCount(0, 1)).toBe(false);
    });
  });
});
