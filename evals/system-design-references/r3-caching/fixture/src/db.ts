export type Report = {
  id: string;
  company: string;
  sections: string[];
  title: string | null;
  shared: boolean;
};

const reports = new Map<string, Report>();

export function getReport(id: string): Report | undefined {
  return reports.get(id);
}

export function saveReport(report: Report): void {
  reports.set(report.id, report);
}
