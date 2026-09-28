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
    [Fact]
    public void SameFingerprintReusesCompletedVerifiedJobWithNewRequestId()
    {
        var registry=new GenerationJobRegistry();var calls=0;
        var first=registry.Start("request-1","same-material",()=>{calls++;return VerifiedJob();});
        first.Job!.Finished=true;first.Job.State="ready";registry.Gate.Release();
        var repeated=registry.Start("request-2","same-material",()=>{calls++;return new();});
        Assert.Equal("reused",repeated.Outcome);Assert.Equal(first.Id,repeated.Id);Assert.Equal(1,calls);
        first.Job.Cancel.Dispose();
    }
    [Fact]
    public void FailedQualityIsRegeneratedEvenWhenFingerprintMatches()
    {
        var registry=new GenerationJobRegistry();var first=registry.Start("request-1","same-material",()=>VerifiedJob("fail"));
        first.Job!.Finished=true;first.Job.State="ready";registry.Gate.Release();
        var repeated=registry.Start("request-2","same-material",()=>new GenerationJob());
        Assert.Equal("started",repeated.Outcome);Assert.NotEqual(first.Id,repeated.Id);
        first.Job.Cancel.Dispose();repeated.Job!.Cancel.Dispose();
    }
    [Fact]
    public void IncompleteSemanticReviewIsNotReused()
    {
        var registry=new GenerationJobRegistry();var result=new SampleResult(Guid.NewGuid(),Guid.NewGuid(),"input","title","body",["1","2","3","4","5"],"1","explanation",["step"],"change")
            {Quality=new QualityReport(QualityReport.CurrentVersion,[new QualityCheck("language","language","pass","checked","ai")])};
        var first=registry.Start("request-1","same-material",()=>new GenerationJob{Outputs=[new ProviderJob("deepseek"){State="ready",Result=result}],Result=result});
        first.Job!.Finished=true;first.Job.State="ready";registry.Gate.Release();
        var repeated=registry.Start("request-2","same-material",()=>new GenerationJob());
        Assert.Equal("started",repeated.Outcome);
        first.Job.Cancel.Dispose();repeated.Job!.Cancel.Dispose();
    }
    [Fact]
    public void SourceFingerprintUsesImageContentInsteadOfTransientSourceId()
    {
        var first=GenerationJobRegistry.SourceFingerprint([new VisualPage([1,2,3],"image/png",1){MaterialRole="question"}]);
        var same=GenerationJobRegistry.SourceFingerprint([new VisualPage([1,2,3],"image/png",1){MaterialRole="question"}]);
        var changed=GenerationJobRegistry.SourceFingerprint([new VisualPage([1,2,4],"image/png",1){MaterialRole="question"}]);
        Assert.Equal(first,same);Assert.NotEqual(first,changed);
    }
    private static GenerationJob VerifiedJob(string semanticState="pass")
    {
        var checks=new[]{"language","conditions","semantic-math","visual-semantics"}.Select(id=>new QualityCheck(id,id,semanticState,"checked","ai")).ToArray();
        var result=new SampleResult(Guid.NewGuid(),Guid.NewGuid(),"input","title","body",["1","2","3","4","5"],"1","explanation",["step"],"change")
            {Quality=new QualityReport(QualityReport.CurrentVersion,checks)};
        return new GenerationJob{Outputs=[new ProviderJob("deepseek"){State="ready",Result=result}],Result=result};
    }
}
