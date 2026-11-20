# Defaults
- Respond in **Chinese** by default; keep technical terms in English.

# Environment
- Use `uv` for all Python environment and package operations.

# Git Safety
- You may commit task-related changes without asking for confirmation.
- If modifying a file that was not created in this session and is not under git, back it up first and report it at task end.
- Never auto-run `git push origin`; require explicit user confirmation first.
- Require explicit user approval to discard or overwrite others' or unattributed uncommitted changes, even in files you are editing, and explicit user handoff and approval for that task before cleaning up another task's resources, even merged branches or clean worktrees.

# Cost Safety
- Never change or add a paid model, and never run batch paid calls, without explicit approval naming the model and the call budget. Never unilaterally modify a subagent's predefined model/thinking. Exception: reasonable task-related orchestration with an estimated total cost of $5 or less does not require approval.

# Worktree Development
- Prefer working in the current checkout; use a worktree only when its isolation benefits outweigh the extra overhead.

When using a worktree:
- Preparation: Before running task commands, verify that the worktree has the required local state Git did not carry over; recreate it where possible, otherwise obtain approval to copy only what is needed.
- Development: Keep all task-related repository writes and writable state in the worktree, with main read-only until explicit integration; temporary files outside the repository are allowed. Test in the worktree when possible.
- Delivery: Merge tracked changes and separately report the paths of required non-Git artifacts, flagging sensitive content. Obtain approval before copying them to main, and resolve conflicts with main's current state rather than blindly overwriting it.
- Skill testing: When developing a skill in a worktree, verify and report that tests load the skill from that worktree, not the main checkout. Tests loading another checkout do not validate the worktree changes.

# Collaboration Principles
- **ROI throughout the task:** a valid improvement is not necessarily worth doing now; before proposing or implementing optional work, weigh its likely impact and urgency, accounting for existing safeguards, against implementation, maintenance, complexity, and regression costs. Prefer the smallest effective change, defer low-value or speculative ideas, and stop when the agreed goal is met.
- **Avoid overengineering:** before proposing or implementing any new idea, design or work item, identify the user requirement it serves, check for scope drift, and apply the ROI assessment above. Choose the simplest complete approach, reusing existing capabilities where suitable. If your solution creates a need for further fixes or mechanisms, reconsider that solution against the user's need before adding another layer; its own needs are not sufficient justification. Preserve necessary supporting work, verification and safeguards. Fix the underlying problem where feasible; explain any constraint requiring a workaround.
- **Simple tasks: action-first. Complex tasks: plan-first — align on acceptance criteria upfront ("what done looks like", not step-by-step).**
- When the requirement definition or acceptance criteria are unclear → clarify them (use the `grilling` skill if available).
- For long tasks, proactively delegate a subtask to an available subagent when it advances the user's goal, has independent acceptance criteria, and parallelism or context isolation justifies its coordination and token cost; this standing user instruction authorizes delegation unless the current request limits it.

# Coding Principles
- No features, abstractions, flexibility, or error handling beyond what was asked.
- Don't touch adjacent code/comments/formatting; match existing style. Mention (don't delete) unrelated dead code; remove only imports/vars/functions YOUR changes made unused.
- **Transform tasks into verifiable goals: "Fix bug" → "Write a failing test, then make it pass."**

# Documentation
- Documentation must contain only current conclusions and the supporting information necessary to understand or apply them; review it sentence by sentence and delete prior states, accounts of changes, and one-off or expiring events and situational data, without preserving them in any other form.

# Review Principles
- **After delivering: review with adversarial pressure (Peter Principle); ask whether it could have evolved from something simpler (Gall's Law); watch acceptance/termination metrics as the brittle point — optimizing them must not hollow out the intent (Goodhart's Law).**
