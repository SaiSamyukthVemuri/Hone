Fixtures for the #683 dormancy guard's cross-module spread test.

These files are NOT shipped and are NOT reachable from the application, so the
adapter guard never scans them; they exist only so that test asserts against
real module resolution instead of against a string literal in the test body.
