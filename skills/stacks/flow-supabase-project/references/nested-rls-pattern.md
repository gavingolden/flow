# Nested RLS Pattern (EXISTS Subquery)

Tables that don't have a direct `user_id` column (e.g., `graphs`, `expressions`) must use an `EXISTS`
subquery to verify ownership through their parent chain.

## Pattern

```sql
-- Child table RLS: verify ownership via parent → grandparent chain
CREATE POLICY "Users can view expressions in their graphs"
    ON expressions FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM graphs
        JOIN dashboards ON dashboards.id = graphs.dashboard_id
        WHERE graphs.id = expressions.graph_id
        AND dashboards.user_id = auth.uid()
    ));

-- Shorthand: use FOR ALL when SELECT/INSERT/UPDATE/DELETE share the same predicate
CREATE POLICY "Users can manage expressions in their graphs"
    ON expressions FOR ALL
    USING (EXISTS (
        SELECT 1 FROM graphs
        JOIN dashboards ON dashboards.id = graphs.dashboard_id
        WHERE graphs.id = expressions.graph_id
        AND dashboards.user_id = auth.uid()
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM graphs
        JOIN dashboards ON dashboards.id = graphs.dashboard_id
        WHERE graphs.id = expressions.graph_id
        AND dashboards.user_id = auth.uid()
    ));
```

## When to Use

- The table has **no direct `user_id`** column
- Ownership is determined through one or more foreign key relationships
- The chain always terminates at a table with `user_id REFERENCES auth.users(id)`

## Performance Note

The `EXISTS` subquery benefits from indexes on the foreign key columns in the join chain
(e.g., `idx_graphs_dashboard_id`, `idx_expressions_graph_id`). These indexes should already
exist per the standard migration template.
