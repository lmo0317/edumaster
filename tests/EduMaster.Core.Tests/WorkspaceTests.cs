using EduMaster.Core;
namespace EduMaster.Core.Tests;

public class WorkspaceTests
{
    [Fact] public void SampleHasOneAnswerAndTracksInput()
    {
        var input = SampleProblems.Nitrogen(); var result = SampleProblems.Generate(input, 0);
        Assert.Equal("③ 4 mol", result.Answer); Assert.Single(result.Choices, s => s == "4 mol");
        Assert.Equal(input.Id, result.InputId); Assert.Equal(input.Fingerprint(), result.InputFingerprint);
        Assert.Contains("수소가 한계 반응물", result.Explanation);
    }
    [Fact] public void SecondSampleCalculatesMass()
    {
        Assert.Equal("③ 80 g", SampleProblems.Generate(SampleProblems.Magnesium(), 0).Answer);
        Assert.Equal("③ 120 g", SampleProblems.Generate(SampleProblems.Magnesium(), 1).Answer);
    }
    [Fact] public void EmptyAndUnrelatedInputsDoNotGenerate()
    {
        Assert.Throws<ArgumentException>(() => SampleProblems.Generate(SampleProblems.Nitrogen() with { Body = "" }, 0));
        Assert.Throws<ArgumentException>(() => SampleProblems.Generate(SampleProblems.Nitrogen() with { Body = "다른 문제" }, 0));
    }
    [Fact] public async Task RestartRestoresInputAndMatchingResult()
    {
        var path = Path.Combine(Path.GetTempPath(), "EduMaster-tests-" + Guid.NewGuid());
        try
        {
            var input = SampleProblems.Nitrogen(); var result = SampleProblems.Generate(input, 0);
            await new StateStore(path).SaveAsync(new(input, result, 1, DateTimeOffset.Now));
            var restored = await new StateStore(path).LoadAsync();
            Assert.Equal(input.Id, restored!.Draft.Id); Assert.Equal(input.Body, restored.Draft.Body);
            Assert.Equal(result.Id, restored.Result!.Id); Assert.Equal(result.Answer, restored.Result.Answer); Assert.Equal(input.Steps, restored.Draft.Steps);
        }
        finally { if (Directory.Exists(path)) Directory.Delete(path, true); }
    }
    [Fact] public async Task FailedSavePreservesLastGoodInput()
    {
        var path = Path.Combine(Path.GetTempPath(), "EduMaster-tests-" + Guid.NewGuid());
        try
        {
            var store = new StateStore(path); var input = SampleProblems.Nitrogen(); await store.SaveAsync(new(input, null, 0, DateTimeOffset.Now));
            await Assert.ThrowsAsync<ArgumentException>(() => store.SaveAsync(new(input with { Body = "" }, null, 0, DateTimeOffset.Now)));
            Assert.Equal(input.Body, (await store.LoadAsync())!.Draft.Body);
            await Assert.ThrowsAsync<InvalidDataException>(() => store.SaveAsync(new(input with { Title = "변경" }, SampleProblems.Generate(input, 0), 0, DateTimeOffset.Now)));
        }
        finally { if (Directory.Exists(path)) Directory.Delete(path, true); }
    }
    [Fact] public async Task CorruptFileIsNotSilentlyReplaced()
    {
        var path = Path.Combine(Path.GetTempPath(), "EduMaster-tests-" + Guid.NewGuid());
        try
        {
            Directory.CreateDirectory(path); var store = new StateStore(path); await File.WriteAllTextAsync(store.FilePath, "broken-json");
            await Assert.ThrowsAsync<System.Text.Json.JsonException>(() => store.LoadAsync()); Assert.Equal("broken-json", await File.ReadAllTextAsync(store.FilePath));
        }
        finally { if (Directory.Exists(path)) Directory.Delete(path, true); }
    }
}
