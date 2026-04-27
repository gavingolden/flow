# Go Testing Patterns

Reference for backend Go tests (`backend/*_test.go`). Loaded on-demand from the `testing` skill.

## Table-Driven Tests

Use `[]struct` + `t.Run()` for exhaustive case coverage. This is the standard Go testing pattern
and keeps test logic DRY:

```go
func TestParseDate(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		want    time.Time
		wantErr bool
	}{
		{name: "ISO format", input: "2025-01-15", want: time.Date(2025, 1, 15, 0, 0, 0, 0, time.UTC)},
		{name: "empty string", input: "", wantErr: true},
		{name: "invalid format", input: "not-a-date", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseDate(tt.input)
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !got.Equal(tt.want) {
				t.Errorf("got %v, want %v", got, tt.want)
			}
		})
	}
}
```

## HTTP Handler Testing with `httptest`

Use `httptest.NewRequest()` and `httptest.NewRecorder()` for handler testing.
Never start a real HTTP server in unit tests:

```go
func TestHealthHandler(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()

	HealthHandler(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}
}
```

## `t.Helper()`

Mark all test utility functions with `t.Helper()` so failure messages report the caller's line
number, not the helper's:

```go
func assertStatusOK(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}
}
```

## General Rules

- Keep test helpers in the same `_test.go` file unless shared across packages.
- Run: `cd backend && go test ./...`
