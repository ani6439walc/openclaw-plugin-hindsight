import importlib.util
import os
import subprocess
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).with_name("jules_pr_review.py")
WORKFLOW = SCRIPT.parents[1] / "workflows" / "jules-pr-review.yml"

spec = importlib.util.spec_from_file_location("jules_pr_review", SCRIPT)
assert spec and spec.loader
jules_pr_review = importlib.util.module_from_spec(spec)
spec.loader.exec_module(jules_pr_review)


class JulesPrReviewTest(unittest.TestCase):
    def test_workflow_grants_contents_write_for_temporary_diff_branch(self):
        self.assertIn("  contents: write\n", WORKFLOW.read_text(encoding="utf-8"))

    def test_workflow_concurrency_group_is_per_pr(self):
        workflow_text = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("group: jules-pr-review-${{ github.event.pull_request.number }}\n", workflow_text)
        self.assertNotIn("group: jules-pr-review-${{ github.event.pull_request.number }}-${{ github.event.pull_request.head.sha }}", workflow_text)

    def test_workflow_author_association_allows_owner_member_collaborator(self):
        workflow_text = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn('contains(fromJSON(\'["OWNER", "MEMBER", "COLLABORATOR"]\'), github.event.pull_request.author_association)', workflow_text)

    def test_workflow_cleanup_is_scoped_to_the_current_run(self):
        workflow_text = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("name: Cleanup temporary diff branch\n        if: always()", workflow_text)
        self.assertIn("RUN_ID: ${{ github.run_id }}", workflow_text)
        self.assertIn('branch="temp/pr-${PR_NUMBER}-diff-${RUN_ID}"', workflow_text)
        self.assertNotIn("git branch -r | grep", workflow_text)

    def test_diff_branch_uses_the_workflow_run_id(self):
        run_id = "123456789"
        with mock.patch.dict(
            os.environ,
            {"GITHUB_RUN_ID": run_id},
        ), mock.patch.object(
            jules_pr_review.subprocess, "run"
        ) as run, mock.patch.object(
            jules_pr_review, "ensure_git_config"
        ), mock.patch.object(
            jules_pr_review, "push_diff_branch"
        ), mock.patch("builtins.open", mock.mock_open()):
            run.return_value.stdout = "abc123\n"
            branch = jules_pr_review.create_diff_branch("57", "diff")

        self.assertEqual(branch, f"temp/pr-57-diff-{run_id}")

    def test_push_failure_reports_sanitized_git_output(self):
        github_token = "github-token-secret"
        jules_api_key = "jules-api-key-secret"
        error = subprocess.CalledProcessError(
            128,
            ["git", "push", "origin", "temp/pr-57-diff-1"],
            output=f"remote: rejected {github_token}",
            stderr=f"fatal: denied {jules_api_key}",
        )

        with mock.patch.dict(
            os.environ,
            {"GITHUB_TOKEN": github_token, "JULES_API_KEY": jules_api_key},
        ):
            with mock.patch.object(
                jules_pr_review.subprocess, "run", side_effect=error
            ):
                with self.assertRaisesRegex(
                    RuntimeError, "Failed to push temporary diff branch"
                ) as raised:
                    jules_pr_review.push_diff_branch("temp/pr-57-diff-1")

        message = str(raised.exception)
        self.assertIn("stdout: remote: rejected [REDACTED]", message)
        self.assertIn("stderr: fatal: denied [REDACTED]", message)
        self.assertNotIn(github_token, message)
        self.assertNotIn(jules_api_key, message)

    def test_jules_headers_require_nonempty_api_key(self):
        with mock.patch.dict(os.environ, {"JULES_API_KEY": ""}, clear=False):
            with self.assertRaisesRegex(RuntimeError, "JULES_API_KEY is missing"):
                jules_pr_review.jules_headers()

        env_without_key = {
            key: value for key, value in os.environ.items() if key != "JULES_API_KEY"
        }
        with mock.patch.dict(os.environ, env_without_key, clear=True):
            with self.assertRaisesRegex(RuntimeError, "JULES_API_KEY is missing"):
                jules_pr_review.jules_headers()

        with mock.patch.dict(os.environ, {"JULES_API_KEY": " real-key "}, clear=False):
            headers = jules_pr_review.jules_headers()
        self.assertEqual(headers["X-Goog-Api-Key"], "real-key")

    def test_request_wraps_network_error(self):
        import urllib.error
        with mock.patch("urllib.request.urlopen", side_effect=urllib.error.URLError("Connection refused")):
            with self.assertRaisesRegex(RuntimeError, "failed \\(network error\\)"):
                jules_pr_review.request("GET", "https://example.com")

    def test_ci_workflow_runs_standard_checks(self):
        ci_workflow = SCRIPT.parents[1] / "workflows" / "ci.yml"
        self.assertTrue(ci_workflow.exists())
        ci_text = ci_workflow.read_text(encoding="utf-8")
        self.assertIn("npm run typecheck", ci_text)
        self.assertIn("npm test", ci_text)
        self.assertIn("npm run build", ci_text)


if __name__ == "__main__":
    unittest.main()