using EduMaster.Web;
namespace EduMaster.Core.Tests;
public class GenerationRetryTests
{
    [Fact]
    public void DuplicateHttpPayloadIgnoresNewDraftIdButIncludesActualMaterialAndProvider()
    {
        var first=new ProblemDraft{Title="test",Body="test body"};var retry=new ProblemDraft{Title="test",Body="test body"};
        Assert.NotEqual(first.Fingerprint(),retry.Fingerprint());
        var fingerprint=GenerationJobRegistry.Fingerprint(first,"deepseek","source-1",true);
        Assert.Equal(fingerprint,GenerationJobRegistry.Fingerprint(retry,"deepseek","source-1",true));
        Assert.NotEqual(fingerprint,GenerationJobRegistry.Fingerprint(retry with{FromSolution=true},"deepseek","source-1",true));
        Assert.NotEqual(fingerprint,GenerationJobRegistry.Fingerprint(retry,"gemma","source-1",true));
        Assert.NotEqual(fingerprint,GenerationJobRegistry.Fingerprint(retry,"deepseek","source-2",true));
    }
    [Fact]
    public async Task ConcurrentRetriesStartOnlyOneGeneration()
    {
        var registry=new GenerationJobRegistry();var calls=0;
        var results=await Task.WhenAll(Enumerable.Range(0,20).Select(_=>Task.Run(()=>registry.Start("request-1","source-a",()=>{Interlocked.Increment(ref calls);return new GenerationJob();}))));
        Assert.Equal(1,calls);Assert.Single(results.Select(r=>r.Id).Distinct());Assert.Single(registry.Jobs);
        Assert.Equal(1,results.Count(r=>r.Outcome=="started"));
        registry.Jobs.Single().Value.Cancel.Dispose();
    }
    [Fact]
    public void ChangedInputCannotReuseRequestId()
    {
        var registry=new GenerationJobRegistry();registry.Start("request-1","source-a",()=>new());
        Assert.Throws<ArgumentException>(()=>registry.Start("request-1","source-b",()=>new()));
        Assert.Single(registry.Jobs);registry.Jobs.Single().Value.Cancel.Dispose();
    }
    [Fact]
    public void RunningAndCompletedRequestsReturnSameJobWhileNewRequestRespectsGate()
    {
        var registry=new GenerationJobRegistry();var first=registry.Start("request-1","source-a",()=>new());
        Assert.Equal("existing",registry.Start("request-1","source-a",()=>throw new Exception()).Outcome);
        Assert.Equal("busy",registry.Start("request-2","source-b",()=>new()).Outcome);
        first.Job!.State="ready";registry.Gate.Release();
        Assert.Equal(first.Id,registry.Start("request-1","source-a",()=>throw new Exception()).Id);
        first.Job.Cancel.Dispose();
    }
}
