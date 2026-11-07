// Cloud Tasks queue "sections" (created in deploy.sh). One task per section.
const QUEUE = process.env.SECTIONS_QUEUE!;

export async function enqueueSection(reportId: string, section: string): Promise<void> {
  await fetch(`https://cloudtasks.googleapis.com/v2/${QUEUE}/tasks`, {
    method: "POST",
    body: JSON.stringify({
      task: {
        httpRequest: {
          url: `${process.env.WORKER_URL}/tasks/generate-section`,
          body: btoa(JSON.stringify({ reportId, section })),
        },
      },
    }),
  });
}
