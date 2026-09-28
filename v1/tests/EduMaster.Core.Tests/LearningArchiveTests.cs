using EduMaster.Core;
using EduMaster.Web;

namespace EduMaster.Core.Tests;

public sealed class LearningArchiveTests
{
    [Fact]
    public async Task PdfLinkSurvivesRestartAndRestagingWithoutReplacingFeedback()
    {
        var directory = Path.Combine(Path.GetTempPath(), "edumaster-learning-" + Guid.NewGuid().ToString("N"));
        try
        {
            var archive = new LearningArchive(directory);
            var first = new SampleResult(Guid.NewGuid(), Guid.NewGuid(), "source", "STEP 1", "문제 본문",
                ["1", "2", "3", "4", "5"], "① 1", "해설", ["풀이"], "변형");
            var second = first with { Id = Guid.NewGuid(), Title = "쌍둥이 문제" };
            var jobId = Guid.NewGuid().ToString("N");
            var pdfId = Guid.NewGuid().ToString("N");
            var job = new GenerationJob { State = "ready", Finished = true, Outputs = [
                new ProviderJob("deepseek", 1, 2, "STEP 1") { State = "ready", Result = first },
                new ProviderJob("deepseek", 2, 2, "전체 로직") { State = "ready", Result = second }] };
            await archive.StageAsync(jobId, job);
            Assert.Null(archive.GetPdfReportId(jobId));
            await archive.ImportAsync(jobId, job, pdfReportId: pdfId);
            var feedback = await archive.AddFeedbackAsync(first.Id.ToString("N"), "method", "풀이 순서가 다릅니다", "원본 풀이 순서를 유지하세요");
            await archive.ReviewAsync(first.Id.ToString("N"), feedback.Id, true);
            var restarted = new LearningArchive(directory);
            await restarted.StageAsync(jobId, job);
            Assert.Equal(pdfId, restarted.GetPdfReportId(jobId));
            Assert.All(restarted.List(), item => { Assert.Equal(pdfId, item.PdfReportId); Assert.Null(item.ReportId); });
            var newerPdf = Guid.NewGuid().ToString("N");
            await restarted.ImportAsync(jobId, job, pdfReportId: newerPdf);
            Assert.All(restarted.List(), item => Assert.Equal(newerPdf, item.PdfReportId));
            Assert.Equal(feedback.Id, Assert.Single(restarted.ListLearned()).FeedbackId);
            await restarted.DeleteAsync(first.Id.ToString("N"));
            await restarted.ImportAsync(jobId, job, pdfReportId: newerPdf);
            Assert.Single(restarted.List());
            Assert.Equal(newerPdf, restarted.GetPdfReportId(jobId));
        }
        finally { Directory.Delete(directory, true); }
    }

    [Fact]
    public async Task PromotingLegacySetAddsPdfToEveryStageAndPreservesFeedback()
    {
        var directory = Path.Combine(Path.GetTempPath(), "edumaster-learning-" + Guid.NewGuid().ToString("N"));
        try
        {
            var archive = new LearningArchive(directory);
            var result = new SampleResult(Guid.NewGuid(), Guid.NewGuid(), "source", "연습", "문제 본문",
                ["1", "2", "3", "4", "5"], "① 1", "해설", ["풀이"], "변형");
            var jobId = Guid.NewGuid().ToString("N");
            var pdfId = Guid.NewGuid().ToString("N");
            await archive.StageAsync(jobId, new GenerationJob { State = "ready", Outputs = [
                new ProviderJob("deepseek", 1, 1, "전체 로직") { State = "ready", Result = result }] });
            await Assert.ThrowsAsync<ArgumentException>(() => archive.PromoteStagedJobAsync(jobId, pdfReportId: "../invalid"));
            Assert.Empty(archive.List());
            Assert.Equal(1, await archive.PromoteStagedJobAsync(jobId, pdfReportId: pdfId));
            var feedback = await archive.AddFeedbackAsync(result.Id.ToString("N"), "solution", "해설에 오류가 있습니다", "계산 과정을 자세히 써주세요", "explanation");
            var newerPdf = Guid.NewGuid().ToString("N");
            await new LearningArchive(directory).PromoteStagedJobAsync(jobId, pdfReportId: newerPdf);
            Assert.Equal(newerPdf, archive.GetPdfReportId(jobId));
            Assert.Equal(feedback.Id, Assert.Single(archive.Get(result.Id.ToString("N"))!.Feedback).Id);
        }
        finally { Directory.Delete(directory, true); }
    }

    [Fact]
    public async Task DeletingProblemRemovesApprovedLearningAndPreventsCacheBackfill()
    {
        var directory = Path.Combine(Path.GetTempPath(), "edumaster-learning-" + Guid.NewGuid().ToString("N"));
        try
        {
            var archive = new LearningArchive(directory);
            var first = new SampleResult(Guid.NewGuid(), Guid.NewGuid(), "first", "산 염기 중화", "산 염기 중화 반응에서 이온 몰수를 구한다",
                ["1", "2", "3", "4", "5"], "② 2", "해설", ["이온 몰수 계산"], "변형") { Model = "DeepSeek" };
            var second = first with { Id = Guid.NewGuid(), Title = "기체 반응량", Body = "기체 반응량을 구한다" };
            var job = new GenerationJob { State = "ready", Finished = true,
                Outputs = [new ProviderJob("deepseek", 1, 2, "STEP 1") { State = "ready", Result = first },
                    new ProviderJob("deepseek", 2, 2, "STEP 1~2") { State = "ready", Result = second }] };
            var jobId = Guid.NewGuid().ToString("N");
            await archive.ImportAsync(jobId, job);
            var firstId = first.Id.ToString("N");
            var approved = await archive.AddFeedbackAsync(firstId, "method", "기호 도입 없이 식이 길어졌습니다", "공통 비율을 문자 t로 놓고 계산하세요");
            await archive.ReviewAsync(firstId, approved.Id, true);
            var pending = await archive.AddFeedbackAsync(firstId, "answer", "정답이 계산과 다르게 표시됐습니다", "정답과 보기 번호를 다시 맞추세요");
            var learned = Assert.Single(archive.ListLearned());
            Assert.Equal(approved.Id, learned.FeedbackId);
            Assert.Equal("method", learned.Category);
            Assert.Equal(firstId, learned.ProblemId);
            Assert.DoesNotContain(archive.ListLearned(), x => x.FeedbackId == pending.Id);
            Assert.Contains("공통 비율", archive.Retrieve(new ProblemDraft { Title = "다른 유형", Body = "행성의 공전 주기를 구한다" }));

            await archive.DeleteAsync(firstId);
            Assert.Null(archive.Get(firstId));
            Assert.Single(archive.List());
            Assert.Empty(archive.ListLearned());
            Assert.Equal("", archive.Retrieve(new ProblemDraft { Title = "연습", Body = first.Body }));
            await Assert.ThrowsAsync<KeyNotFoundException>(() => archive.DeleteAsync(firstId));
            var restarted = new LearningArchive(directory);
            await restarted.ImportAsync(jobId, job);
            Assert.Single(restarted.List());
            Assert.Null(restarted.Get(firstId));
            Assert.True(File.Exists(Path.Combine(directory, firstId + ".deleted")));
        }
        finally { Directory.Delete(directory, true); }
    }

    [Fact]
    public async Task OnlyApprovedSimilarFeedbackIsRetrievedAndSurvivesRestart()
    {
        var directory = Path.Combine(Path.GetTempPath(), "edumaster-learning-" + Guid.NewGuid().ToString("N"));
        try
        {
            var archive = new LearningArchive(directory);
            var source = "산 염기 중화 반응에서 음이온 양이온 몰수 비를 계산한다";
            var result = new SampleResult(Guid.NewGuid(), Guid.NewGuid(), "fingerprint", "산 염기 중화 반응", source,
                ["1", "2", "3", "4", "5"], "② 2", "검산", ["이온 몰수 계산"], "변형") { SourceProblem = source, Model = "DeepSeek" };
            var output = new ProviderJob("deepseek", 1, 2, "STEP 1") { State = "ready", Result = result };
            var job = new GenerationJob { State = "ready", Finished = true, Outputs = [output], Result = result };
            var jobId = Guid.NewGuid().ToString("N");
            await archive.ImportAsync(jobId, job);
            Assert.Single(archive.List());
            var id = result.Id.ToString("N");
            var feedback = await archive.AddFeedbackAsync(id, "answer", "산성 가정이 이온 몰수 비와 모순됩니다", "전하 균형을 계산하고 염기성 경우를 확인하세요");
            var similar = new ProblemDraft { Title = "연습", Body = "산 염기 중화 반응에서 음이온 양이온 몰수 비를 구한다" };
            Assert.Equal("", archive.Retrieve(similar));
            await archive.ReviewAsync(id, feedback.Id, true);
            var rejected = await archive.AddFeedbackAsync(id, "wording", "문장에 불명확한 표기가 남아 있습니다", "학생이 해석할 수 있게 용어를 풀어 쓰세요");
            await archive.ReviewAsync(id, rejected.Id, false);
            await archive.ImportAsync(jobId, job);
            var restored = new LearningArchive(directory);
            Assert.Contains("전하 균형", restored.Retrieve(similar));
            Assert.DoesNotContain("용어를 풀어", restored.Retrieve(similar));
            Assert.Equal("", restored.Retrieve(new ProblemDraft { Title = "연습", Body = "행성의 공전 주기와 위성의 거리 관계" }));
            Assert.Equal(1, restored.List()[0].ApprovedCount);
            Assert.Equal(2, restored.List()[0].FeedbackCount);
            await Assert.ThrowsAsync<ArgumentException>(() => restored.ReviewAsync(id, feedback.Id, true));
        }
        finally { Directory.Delete(directory, true); }
    }

    [Fact]
    public async Task ApprovedTeacherMethodCanGuideAnotherTopicWithoutCopyingAnswerFeedback()
    {
        var directory=Path.Combine(Path.GetTempPath(),"edumaster-learning-"+Guid.NewGuid().ToString("N"));
        try{
            var archive=new LearningArchive(directory);
            var result=new SampleResult(Guid.NewGuid(),Guid.NewGuid(),"fingerprint","화학 반응량", "기체 반응량을 계산한다",
                ["1","2","3","4","5"],"② 2","해설",["비교"],"변형");
            var job=new GenerationJob {State="ready",Finished=true,Result=result,
                Outputs=[new ProviderJob("deepseek",1,1,"전체 로직") {State="ready",Result=result}]};
            await archive.ImportAsync(Guid.NewGuid().ToString("N"),job);
            var id=result.Id.ToString("N");
            var preference=await archive.AddFeedbackAsync(id,"method","기호 도입을 생략해 식이 길어졌습니다","공통 비율을 문자 t로 놓아 먼저 식을 단순화하세요");
            var unrelated=await archive.AddFeedbackAsync(id,"answer","정답의 계산이 틀렸습니다","정답을 4로 고치세요");
            await archive.ReviewAsync(id,preference.Id,true);
            await archive.ReviewAsync(id,unrelated.Id,true);
            var context=archive.Retrieve(new ProblemDraft{Title="다른 유형",Body="행성의 공전 주기와 위성의 거리 관계"});
            Assert.Contains("문자 t",context);
            Assert.DoesNotContain("정답을 4",context);
        }finally{Directory.Delete(directory,true);}
    }
    [Fact]
    public async Task FeedbackKeepsItsStageAndProblemOrExplanationTarget()
    {
        var directory=Path.Combine(Path.GetTempPath(),"edumaster-learning-"+Guid.NewGuid().ToString("N"));
        try{
            var archive=new LearningArchive(directory);
            var first=new SampleResult(Guid.NewGuid(),Guid.NewGuid(),"source","STEP 1","문제 본문",["1","2","3","4","5"],"① 1","해설",["풀이"],"변형");
            var second=first with{Id=Guid.NewGuid(),Title="쌍둥이 문제"};
            var jobId=Guid.NewGuid().ToString("N");
            await archive.ImportAsync(jobId,new GenerationJob{State="ready",Finished=true,Outputs=[
                new ProviderJob("deepseek",1,2,"STEP 1"){State="ready",Result=first},
                new ProviderJob("deepseek",2,2,"전체 로직 쌍둥이 문제"){State="ready",Result=second}]});
            var summaries=archive.List();
            Assert.Equal(2,summaries.Length);
            Assert.All(summaries,item=>Assert.Equal(jobId,item.JobId));
            var firstId=first.Id.ToString("N");
            var question=await archive.AddFeedbackAsync(firstId,"condition","표의 질량이 모순됩니다","반응량에 맞게 질량을 고치세요","problem");
            var solution=await archive.AddFeedbackAsync(firstId,"solution","두 번째 계산이 맞지 않습니다","물질량을 다시 계산하세요","explanation");
            await archive.ReviewAsync(firstId,solution.Id,true);
            var restored=new LearningArchive(directory);
            var entry=restored.Get(firstId)!;
            Assert.Equal("problem",entry.Feedback.Single(f=>f.Id==question.Id).Target);
            Assert.Equal("explanation",entry.Feedback.Single(f=>f.Id==solution.Id).Target);
            Assert.Equal("explanation",Assert.Single(restored.ListLearned()).Target);
            Assert.Empty(restored.Get(second.Id.ToString("N"))!.Feedback);
            await Assert.ThrowsAsync<ArgumentException>(()=>restored.AddFeedbackAsync(firstId,"solution","잘못된 풀이입니다","다시 계산해 주세요","whole-set"));
        }finally{Directory.Delete(directory,true);}
    }
    [Fact]
    public async Task GeneratedSetIsHiddenUntilTeacherAddsItToLearning()
    {
        var directory=Path.Combine(Path.GetTempPath(),"edumaster-learning-"+Guid.NewGuid().ToString("N"));
        try{
            var archive=new LearningArchive(directory);
            var source="기체 반응량을 계산하는 기준 문제";
            var first=new SampleResult(Guid.NewGuid(),Guid.NewGuid(),"fingerprint","STEP 1",source,["1","2","3","4","5"],"① 1","해설",["판단"],"변형"){SourceProblem=source};
            var second=first with{Id=Guid.NewGuid(),Title="전체 로직 쌍둥이 문제"};
            var jobId=Guid.NewGuid().ToString("N");
            var job=new GenerationJob{State="ready",Finished=true,Outputs=[
                new ProviderJob("deepseek",1,2,"STEP 1"){State="ready",Result=first},
                new ProviderJob("deepseek",2,2,"전체 로직 쌍둥이 문제"){State="ready",Result=second}]};
            await archive.StageAsync(jobId,job);
            Assert.Empty(archive.List());
            Assert.Null(archive.Get(first.Id.ToString("N")));
            Assert.False(archive.HasJob(jobId));
            Assert.Equal(2,await archive.PromoteStagedJobAsync(jobId));
            Assert.Equal(2,archive.List().Length);
            Assert.True(archive.HasJob(jobId));
            var restarted=new LearningArchive(directory);
            await restarted.StageAsync(jobId,job);
            Assert.Equal(2,restarted.List().Length);
            Assert.Equal(2,await restarted.PromoteStagedJobAsync(jobId));
        }finally{Directory.Delete(directory,true);}
    }
}
