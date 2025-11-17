/*
Author: Matt Bonilla
*/

var globe = globe || {};

globe.HomePageController = class
{
    catTab = [0, 0, 0, 0];

    constructor() 
    {

        // Adds EventListeners to all Navbar buttons
        document.querySelectorAll("li.nav-item > a.navbar-button").forEach(element => 
        {
            element.addEventListener("click", (event) => 
            {
                    this.updateActiveButton(element.id);
            });
        });

        // Adds EventListeners to all CatTab buttons
        document.querySelectorAll("div.home-project-container-content > div.cat-clickable").forEach(element => 
        {
            element.addEventListener("click", (event) => 
            {
                this.updateActiveCatTab(element);
            });
        });

        //this.fetchWebsite("ece-300");

        console.log("Home Page Controller Created");
    }

    // Controls the cat tab's 'Active effect.
    updateActiveCatTab = function(catTab)
    {
        let catTabIndex = $(catTab).data("index");
        console.log(catTabIndex);
  
        switch (this.catTab[catTabIndex])
        {
            case 0:
                this.catTab[catTabIndex] = 1;
                $(catTab).css("background-color","#95d6ed")
                break;
  
            case 1:
                this.catTab[catTabIndex] = 0;
                $(catTab).css("background-color","#7ea5e1")
                break;
              
            default:
                break;
        };
    }

    // Controls the navbar's 'Active' effect.
    updateActiveButton = function(activeButton)
    {
        document.querySelectorAll("li.nav-item > a.navbar-button").forEach(element => 
        {
            if (element.id == activeButton)
                element.classList.add("active");
            else
                element.classList.remove("active");
        });
    }

    fetchWebsite = function(courseName)
    {
        $.ajax(
        {
            url: `https://www.rose-hulman.edu/academics/course-catalog/current/programs/Electrical%20Engineering/${courseName}.html`,
            processData: false,
            data: sParameters,
            success: function(sResponse) 
            {
              console.log("Done: " + sResponse);
            }
        });
    }
}


/* Main */
/** function and class syntax examples */
globe.main = function () 
{
    new globe.HomePageController();
};

globe.main();