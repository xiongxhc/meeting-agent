# Human checklist

Steps that need a human (real accounts, live services, or repo hosting
decisions) and were deliberately not attempted by the agent. Grouped by plan
task.

## Plan 1 Task 0: Bootstrap the public package

- [ ] Create the GitHub repository `xiongxhc/meeting-agent`. The local `origin`
  remote is already configured to `git@github.com:xiongxhc/meeting-agent.git`,
  but the repository itself does not exist on GitHub yet. Run:

  ```
  gh repo create xiongxhc/meeting-agent --public --description "Meeting Agent: reusable meeting engine"
  ```

  Do not pass `--source`/`--remote` to that command since `origin` is already
  set locally. Then push the branch:

  ```
  git push -u origin feat/meeting-agent-core
  ```
