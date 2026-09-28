namespace EduMaster.Core;

public static class GenerationQualityPolicy
{
    public static bool CanStartFromSource(QualityCheck? sourceCheck)
        => sourceCheck?.State != "fail";

    public static bool CanCompleteDraft(QualityReport? report)
        => report is not null && report.State != "fail"
           && report.Checks.Any(c=>c.Id=="conditions"&&c.State=="pass")
           && report.Checks.Any(c=>c.Id=="semantic-math"&&c.State=="pass");
}
