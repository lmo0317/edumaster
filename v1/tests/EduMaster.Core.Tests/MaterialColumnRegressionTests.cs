using EduMaster.Core;
using EduMaster.App;
namespace EduMaster.Core.Tests;

public class MaterialColumnRegressionTests
{
    [Fact]public async Task SparseLeftColumnKeepsRightColumnStepContinuation()
    {
        var page=new VisualPage(await File.ReadAllBytesAsync(Path.Combine(AppContext.BaseDirectory,"Fixtures","two-column-teacher-solution.png")),"image/png",2){MaterialRole="solution"};
        var regions=await LocalDocumentReader.MaterialViewsAsync(page,CancellationToken.None);
        Assert.Equal(2,regions.Length);
        Assert.All(regions,r=>Assert.Equal("solution",r.MaterialRole));
        Assert.Contains("왼쪽 열",regions[0].ReadingRegion);
        Assert.Contains("첫 STEP 제목 위",regions[1].ReadingRegion);
        var views=await LocalDocumentReader.ReadableMaterialViewsAsync(regions,CancellationToken.None);
        foreach(var view in views.Where(v=>v.ReadingRegion.StartsWith("해설의 오른쪽 열")))Assert.Contains("앞 STEP에 연결",ProblemSolutionMaterial.ViewLabel(view));
        Assert.True(views.Count(v=>v.ReadingRegion.StartsWith("해설의 오른쪽 열"))>=2);
    }
}
