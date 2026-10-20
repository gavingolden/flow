# The planning sub-agent

Planning is delegated to one sub-agent. It is given a long instruction document
of numbered steps and writes a plan file. One step in that document is
"research": search the web for current facts about the change, then fold the
cited findings into the plan. The step is marked optional unless the user asked
for research explicitly, in which case it is marked required.

The step is described in prose. The sub-agent decides for itself, while reading
its instructions, whether to carry the step out. In a recorded run where the
user had asked for research, the sub-agent wrote the plan without ever running
the step, and nothing downstream noticed until the user read the plan.
