//! Cell merge: last writer wins per `(table, rowId, column)` (PROTOCOL.md §4).

use std::collections::BTreeMap;

use crate::payload::Change;

/// A change replaces the current cell iff its HLC string is strictly greater.
pub fn wins(current_hlc: Option<&str>, incoming_hlc: &str) -> bool {
    current_hlc.is_none_or(|c| incoming_hlc > c)
}

/// In-memory cell state of one space (the reference for storage implementations).
#[derive(Debug, Default, Clone)]
pub struct Cells(pub BTreeMap<(String, String, String), Change>);

impl Cells {
    /// Apply changes; returns how many replaced a cell.
    pub fn apply<'a>(&mut self, changes: impl IntoIterator<Item = &'a Change>) -> usize {
        let mut n = 0;
        for c in changes {
            let k = (c.table.clone(), c.row_id.clone(), c.column.clone());
            if wins(self.0.get(&k).map(|x| x.hlc.as_str()), &c.hlc) {
                self.0.insert(k, c.clone());
                n += 1;
            }
        }
        n
    }
}
