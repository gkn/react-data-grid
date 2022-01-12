import { forwardRef, useCallback, useMemo } from 'react';
import type { Key, RefAttributes } from 'react';

import DataGrid from './DataGrid';
import type { DataGridProps, DataGridHandle, DefaultColumnOptions } from './DataGrid';
import GroupedRowRenderer from './GroupRow';
import type {
  CalculatedColumn,
  Column,
  RowsChangeData,
  PasteEvent,
  RowHeightArgs,
  Maybe,
  GroupRow,
  Omit,
  GroupRowHeightArgs,
  RowRendererProps
} from './types';
import { SELECT_COLUMN_KEY, ToggleGroupFormatter } from '.';
import type { GroupApi } from './hooks';
import { useLatestFunc, GroupApiProvider } from './hooks';
import { assertIsValidKeyGetter } from './utils';

export interface TreeDataGridProps<R, SR = unknown, K extends Key = Key>
  extends Omit<DataGridProps<R, SR, K>, 'rowHeight' | 'onFill'> {
  rowHeight?: Maybe<number | ((args: GroupRowHeightArgs<R>) => number)>;
  groupBy: readonly string[];
  rowGrouper: (rows: readonly R[], columnKey: string) => Record<string, readonly R[]>;
  expandedGroupIds: ReadonlySet<unknown>;
  onExpandedGroupIdsChange: (expandedGroupIds: Set<unknown>) => void;
}

type GroupByDictionary<TRow> = Record<
  string,
  {
    readonly childRows: readonly TRow[];
    readonly childGroups: readonly TRow[] | Readonly<GroupByDictionary<TRow>>;
    readonly startRowIndex: number;
  }
>;

function TreeDataGrid<R, SR, K extends Key>(
  {
    columns: rawColumns,
    rows: rawRows,
    rowHeight: rawRowHeight,
    rowRenderer,
    rowClass: rawRowClass,
    rowKeyGetter: rawRowKeyGetter,
    onRowsChange: rawOnRowsChange,
    onRowClick: rawOnRowClick,
    onRowDoubleClick: rawOnRowDoubleClick,
    onPaste: rawOnPaste,
    defaultColumnOptions,
    selectedRows,
    onSelectedRowsChange,
    groupBy: rawGroupBy,
    rowGrouper,
    expandedGroupIds,
    onExpandedGroupIdsChange,
    ...props
  }: TreeDataGridProps<R, SR, K>,
  ref: React.Ref<DataGridHandle>
) {
  // const isSelectable = selectedRows != null && onSelectedRowsChange != null;
  const toggleGroupLatest = useLatestFunc(toggleGroup);
  const toggleGroupSelectionLatest = useLatestFunc(toggleGroupSelection);

  const { columns, groupBy } = useMemo(() => {
    const columns = [...rawColumns].sort(({ key: aKey }, { key: bKey }) => {
      // Sort select column first:
      if (aKey === SELECT_COLUMN_KEY) return -1;
      if (bKey === SELECT_COLUMN_KEY) return 1;

      // Sort grouped columns second, following the groupBy order:
      if (rawGroupBy.includes(aKey)) {
        if (rawGroupBy.includes(bKey)) {
          return rawGroupBy.indexOf(aKey) - rawGroupBy.indexOf(bKey);
        }
        return -1;
      }
      if (rawGroupBy.includes(bKey)) return 1;

      // Sort other columns last:
      return 0;
    });

    const groupBy: string[] = [];
    for (const [index, column] of columns.entries()) {
      if (rawGroupBy.includes(column.key)) {
        groupBy.push(column.key);
        columns[index] = {
          ...column,
          frozen: true,
          formatter: () => null,
          groupFormatter: column.groupFormatter ?? ToggleGroupFormatter,
          editable: false
        };
      }
    }

    return { columns, groupBy };
  }, [rawColumns, rawGroupBy]);

  const [groupedRows, rowsCount] = useMemo(() => {
    if (groupBy.length === 0) return [undefined, rawRows.length];

    const groupRows = (
      rows: readonly R[],
      [groupByKey, ...remainingGroupByKeys]: readonly string[],
      startRowIndex: number
    ): [Readonly<GroupByDictionary<R>>, number] => {
      let groupRowsCount = 0;
      const groups: GroupByDictionary<R> = {};
      for (const [key, childRows] of Object.entries(rowGrouper(rows, groupByKey))) {
        // Recursively group each parent group
        const [childGroups, childRowsCount] =
          remainingGroupByKeys.length === 0
            ? [childRows, childRows.length]
            : groupRows(childRows, remainingGroupByKeys, startRowIndex + groupRowsCount + 1); // 1 for parent row
        groups[key] = { childRows, childGroups, startRowIndex: startRowIndex + groupRowsCount };
        groupRowsCount += childRowsCount + 1; // 1 for parent row
      }

      return [groups, groupRowsCount];
    };

    return groupRows(rawRows, groupBy, 0);
  }, [groupBy, rowGrouper, rawRows]);

  const [rows, isGroupRow] = useMemo((): [
    ReadonlyArray<R | GroupRow<R>>,
    (row: R | GroupRow<R>) => row is GroupRow<R>
  ] => {
    const allGroupRows = new Set<unknown>();
    if (!groupedRows) return [rawRows, isGroupRow];

    const flattenedRows: Array<R | GroupRow<R>> = [];
    const expandGroup = (
      rows: GroupByDictionary<R> | readonly R[],
      parentId: string | undefined,
      level: number
    ): void => {
      if (isReadonlyArray(rows)) {
        flattenedRows.push(...rows);
        return;
      }
      Object.keys(rows).forEach((groupKey, posInSet, keys) => {
        // TODO: should users have control over the generated key?
        const id = parentId !== undefined ? `${parentId}__${groupKey}` : groupKey;
        const isExpanded = expandedGroupIds.has(id);
        const { childRows, childGroups, startRowIndex } = rows[groupKey];

        const groupRow: GroupRow<R> = {
          id,
          parentId,
          groupKey,
          isExpanded,
          childRows,
          level,
          posInSet,
          startRowIndex,
          setSize: keys.length
        };
        flattenedRows.push(groupRow);
        allGroupRows.add(groupRow);

        if (isExpanded) {
          expandGroup(childGroups, id, level + 1);
        }
      });
    };

    expandGroup(groupedRows, undefined, 0);
    return [flattenedRows, isGroupRow];

    function isGroupRow(row: R | GroupRow<R>): row is GroupRow<R> {
      return allGroupRows.has(row);
    }
  }, [expandedGroupIds, groupedRows, rawRows]);

  const rowHeight = useMemo(() => {
    if (typeof rawRowHeight === 'function') {
      return ({ row, type }: RowHeightArgs<R | GroupRow<R>>): number => {
        if (isGroupRow(row)) {
          return rawRowHeight({ type: 'GROUP', row });
        }
        return rawRowHeight({ row, type });
      };
    }

    return rawRowHeight;
  }, [isGroupRow, rawRowHeight]);

  const rowClass = useMemo(() => {
    if (typeof rawRowClass === 'function') {
      return (row: R | GroupRow<R>) => {
        if (isGroupRow(row)) {
          throw new Error('rowClass is not supported on a group row');
        }
        return rawRowClass(row);
      };
    }

    return rawRowClass;
  }, [isGroupRow, rawRowClass]);

  const rowKeyGetter = useMemo(() => {
    // TODO: fix row key on child rows
    if (typeof rawRowKeyGetter === 'function') {
      return (row: R | GroupRow<R>): K => {
        if (isGroupRow(row)) {
          return row.id as K;
        }
        return rawRowKeyGetter(row);
      };
    }

    return rawRowKeyGetter;
  }, [isGroupRow, rawRowKeyGetter]);

  const onRowsChange =
    typeof rawOnRowsChange === 'function'
      ? (rows: (R | GroupRow<R>)[], { indexes, column }: RowsChangeData<R | GroupRow<R>, SR>) => {
          const rawIndexes = indexes.map((index) => rawRows.indexOf(rows[index] as R));
          rawOnRowsChange(rows as R[], {
            indexes: rawIndexes,
            column: column as CalculatedColumn<R, SR>
          });
        }
      : rawOnRowsChange;

  const onRowClick = useMemo(() => {
    if (typeof rawOnRowClick === 'function') {
      return (row: R | GroupRow<R>, column: CalculatedColumn<R | GroupRow<R>, SR>) => {
        if (isGroupRow(row)) {
          throw new Error('onRowClick is not supported on a group row');
        }
        rawOnRowClick(row, column as CalculatedColumn<R, SR>);
      };
    }

    return rawOnRowClick;
  }, [isGroupRow, rawOnRowClick]);

  const onRowDoubleClick = useMemo(() => {
    if (typeof rawOnRowDoubleClick === 'function') {
      return (row: R | GroupRow<R>, column: CalculatedColumn<R | GroupRow<R>, SR>) => {
        if (isGroupRow(row)) {
          throw new Error('onRowDoubleClick is not supported on a group row');
        }
        rawOnRowDoubleClick(row, column as CalculatedColumn<R, SR>);
      };
    }

    return rawOnRowDoubleClick;
  }, [isGroupRow, rawOnRowDoubleClick]);

  const onPaste = useMemo(() => {
    if (typeof rawOnPaste === 'function') {
      return ({ sourceRow, targetRow, ...rest }: PasteEvent<R | GroupRow<R>>) => {
        if (isGroupRow(sourceRow) || isGroupRow(targetRow)) {
          throw new Error('onPaste is not supported on a group row');
        }
        return rawOnPaste({ sourceRow, targetRow, ...rest });
      };
    }

    return rawOnPaste;
  }, [isGroupRow, rawOnPaste]);

  const getParentRow = useCallback(
    (row: GroupRow<R>) => {
      const rowIdx = rows.indexOf(row);
      for (let i = rowIdx - 1; i >= 0; i--) {
        const parentRow = rows[i];
        if (isGroupRow(parentRow) && parentRow.id === row.parentId) {
          return parentRow;
        }
      }

      return undefined;
    },
    [isGroupRow, rows]
  );

  const value = useMemo(
    (): GroupApi<R, SR> => ({
      isGroupRow,
      toggleGroup: toggleGroupLatest,
      toggleGroupSelection: toggleGroupSelectionLatest,
      getParentRow,
      rowRenderer: rowRenderer as Maybe<React.ComponentType<RowRendererProps<R | GroupRow<R>, SR>>>
    }),
    [isGroupRow, toggleGroupLatest, toggleGroupSelectionLatest, getParentRow, rowRenderer]
  );

  function toggleGroup(expandedGroupId: unknown) {
    const newExpandedGroupIds = new Set(expandedGroupIds);
    if (newExpandedGroupIds.has(expandedGroupId)) {
      newExpandedGroupIds.delete(expandedGroupId);
    } else {
      newExpandedGroupIds.add(expandedGroupId);
    }
    onExpandedGroupIdsChange(newExpandedGroupIds);
  }

  function toggleGroupSelection(row: GroupRow<R>, checked: boolean) {
    if (!onSelectedRowsChange) return;
    assertIsValidKeyGetter<R, K>(rawRowKeyGetter);
    const newSelectedRows = new Set(selectedRows);
    for (const childRow of row.childRows) {
      const rowKey = rawRowKeyGetter(childRow);
      if (checked) {
        newSelectedRows.add(rowKey);
      } else {
        newSelectedRows.delete(rowKey);
      }
    }
    onSelectedRowsChange(newSelectedRows);
  }

  return (
    <GroupApiProvider value={value}>
      <DataGrid<R | GroupRow<R>, SR, K>
        aria-rowcount={rowsCount + 1 + (props.summaryRows?.length ?? 0)}
        ref={ref}
        columns={columns as Column<R | GroupRow<R>, SR>[]}
        rows={rows}
        rowHeight={rowHeight}
        rowKeyGetter={rowKeyGetter}
        rowClass={rowClass}
        onRowsChange={onRowsChange}
        onRowClick={onRowClick}
        onRowDoubleClick={onRowDoubleClick}
        defaultColumnOptions={
          defaultColumnOptions as Maybe<DefaultColumnOptions<R | GroupRow<R>, SR>>
        }
        selectedRows={selectedRows}
        onSelectedRowsChange={onSelectedRowsChange}
        onPaste={onPaste}
        rowRenderer={GroupedRowRenderer}
        {...props}
      />
    </GroupApiProvider>
  );
}

function isReadonlyArray(arr: unknown): arr is readonly unknown[] {
  return Array.isArray(arr);
}

export default forwardRef(TreeDataGrid) as <R, SR = unknown, K extends Key = Key>(
  props: TreeDataGridProps<R, SR, K> & RefAttributes<DataGridHandle>
) => JSX.Element;
