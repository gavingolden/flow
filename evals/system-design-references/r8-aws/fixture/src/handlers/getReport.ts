import type { APIGatewayProxyHandler } from "aws-lambda";
import { getReport } from "../db";

export const handler: APIGatewayProxyHandler = async (event) => {
  const report = await getReport(event.pathParameters!.id!);
  return report
    ? { statusCode: 200, body: JSON.stringify(report) }
    : { statusCode: 404, body: JSON.stringify({ error: "not found" }) };
};
