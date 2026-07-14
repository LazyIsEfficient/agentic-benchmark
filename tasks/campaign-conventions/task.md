# Campaign fixture — see `meta.json` `campaign`

This is a LONGITUDINAL campaign, not a single task. Its five links live in
`t1.md`–`t5.md` and are declared under `campaign` in `meta.json`; the campaign
runner executes them in order against one persistent workspace. This `task.md`
exists only so the current (not-yet-campaign-aware) task loader can list the
fixture without a missing-`task.md` error — it is not the scored prompt.

Start with `t1.md`.
