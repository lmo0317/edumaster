using EduMaster.Core;

namespace EduMaster.Core.Tests;

public class GenerationQualityPolicyTests
{
    [Theory]
    [InlineData("pass", true)]
    [InlineData("unknown", true)]
    [InlineData("fail", false)]
    public void SourceUnknownIsAWarningButSourceFailureStillBlocks(string state, bool expected)
    {
        var check = new QualityCheck("source-calculation", "입력 문제 풀이 검산", state, "근거", "code");
        Assert.Equal(expected, GenerationQualityPolicy.CanStartFromSource(check));
    }

    [Fact]
    public void ReviewRequiredDraftCanFinishButFailedDraftCannot()
    {
        var reviewRequired = new QualityReport(QualityReport.CurrentVersion,
        [
            new("conditions", "조건", "pass", "성립", "ai"),
            new("semantic-math", "수치", "pass", "일치", "ai"),
            new("calculation", "독립 수치 검산", "unknown", "미지원", "code")
        ]);
        Assert.True(GenerationQualityPolicy.CanCompleteDraft(reviewRequired));
        Assert.False(GenerationQualityPolicy.CanCompleteDraft(reviewRequired with
        {
            Checks = reviewRequired.Checks.Append(new("visual-data", "그림", "fail", "누락", "code")).ToArray()
        }));
        Assert.False(GenerationQualityPolicy.CanCompleteDraft(null));
    }
}
